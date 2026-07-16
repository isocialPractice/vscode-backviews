/**
 * Minimal WebGL renderer: one shader program, one procedural texture atlas,
 * and a set of chunk meshes streamed in by the world as the player walks.
 *
 * Vertex layout (10 floats): position(3), uv(2, tile-local, repeats via
 * fract), tileIndex(1), tint(3), shade(1). A shade above the EMISSIVE
 * threshold marks light-panel geometry: it ignores fog and multiplies by the
 * flicker uniform instead of scene lighting.
 */
import { applyMaterialImages as patchAtlas, ATLAS_GRID, buildAtlas, MaterialImages } from './textures';

export const FLOATS_PER_VERTEX = 10;
export const EMISSIVE_SHADE = 2.0;

const VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec2 aUv;
attribute float aTile;
attribute vec3 aTint;
attribute float aShade;

uniform mat4 uViewProj;
uniform vec3 uCamPos;

varying vec2 vUv;
varying float vTile;
varying vec3 vTint;
varying float vShade;
varying float vDist;

void main() {
  vUv = aUv;
  vTile = aTile;
  vTint = aTint;
  vShade = aShade;
  vDist = distance(aPosition, uCamPos);
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SRC = `
precision mediump float;

uniform sampler2D uAtlas;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFlicker;

varying vec2 vUv;
varying float vTile;
varying vec3 vTint;
varying float vShade;
varying float vDist;

const float GRID = ${ATLAS_GRID.toFixed(1)};

void main() {
  float tile = floor(vTile + 0.5);
  vec2 cell = vec2(mod(tile, GRID), floor(tile / GRID));
  // Half-texel inset keeps repeated tiles from bleeding across atlas seams.
  vec2 local = fract(vUv) * (1.0 - 2.0 / 256.0) + 1.0 / 256.0;
  vec4 tex = texture2D(uAtlas, (cell + local) / GRID);

  if (vShade >= ${EMISSIVE_SHADE.toFixed(1)} - 0.25) {
    // Emissive light panel: flicker, no fog fade.
    vec3 lit = tex.rgb * vTint * uFlicker * (vShade - 1.0);
    float glowFog = 1.0 - exp(-vDist * vDist * uFogDensity * 0.35);
    gl_FragColor = vec4(mix(lit, uFogColor, glowFog), 1.0);
    return;
  }

  vec3 color = tex.rgb * vTint * vShade * uFlicker;
  float fog = 1.0 - exp(-vDist * vDist * uFogDensity);
  gl_FragColor = vec4(mix(color, uFogColor, fog), 1.0);
}
`;

// Decal pass for wall writing: plain UVs into a dedicated RGBA texture,
// alpha-blended over the walls after the opaque passes.
export const FLOATS_PER_DECAL_VERTEX = 6;

const DECAL_VERTEX_SRC = `
attribute vec3 aPosition;
attribute vec2 aUv;
attribute float aShade;

uniform mat4 uViewProj;
uniform vec3 uCamPos;

varying vec2 vUv;
varying float vShade;
varying float vDist;

void main() {
  vUv = aUv;
  vShade = aShade;
  vDist = distance(aPosition, uCamPos);
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

const DECAL_FRAGMENT_SRC = `
precision mediump float;

uniform sampler2D uTexture;
uniform float uFogDensity;
uniform float uFlicker;

varying vec2 vUv;
varying float vShade;
varying float vDist;

void main() {
  vec4 tex = texture2D(uTexture, vUv);
  float fog = 1.0 - exp(-vDist * vDist * uFogDensity);
  // Ink dims with the wall lighting and dissolves into the fog.
  gl_FragColor = vec4(tex.rgb * vShade * uFlicker, tex.a * (1.0 - fog));
}
`;

export interface ChunkMesh {
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  indexCount: number;
}

export interface Camera {
  x: number;
  y: number;
  z: number;
  /** Heading around the vertical axis, radians. */
  yaw: number;
  /** Look up/down, radians. */
  pitch: number;
  /** Handheld tilt, radians. */
  roll: number;
  fovY: number;
}

export class Renderer {
  readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly attribs: Record<string, number>;
  private readonly canvas: HTMLCanvasElement;
  fogColor: [number, number, number] = [0.055, 0.048, 0.02];
  fogDensity = 0.012;

  // One rewritable mesh for animated geometry (the monster), rebuilt per frame.
  private dynVbo: WebGLBuffer | null = null;
  private dynIbo: WebGLBuffer | null = null;
  private dynCount = 0;

  private readonly atlasCanvas: HTMLCanvasElement;
  private readonly atlasTexture: WebGLTexture | null;

  // Wall-writing decals: separate program, texture, and mesh, rebuilt only
  // when a new line is scrawled.
  private readonly decalProgram: WebGLProgram;
  private readonly decalUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly decalAttribs: Record<string, number>;
  private decalTexture: WebGLTexture | null = null;
  private decalVbo: WebGLBuffer | null = null;
  private decalIbo: WebGLBuffer | null = null;
  private decalCount = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) {
      throw new Error('WebGL is not available in this webview');
    }
    this.gl = gl;
    this.program = buildProgram(gl, VERTEX_SRC, FRAGMENT_SRC);

    this.attribs = {
      aPosition: gl.getAttribLocation(this.program, 'aPosition'),
      aUv: gl.getAttribLocation(this.program, 'aUv'),
      aTile: gl.getAttribLocation(this.program, 'aTile'),
      aTint: gl.getAttribLocation(this.program, 'aTint'),
      aShade: gl.getAttribLocation(this.program, 'aShade'),
    };
    this.uniforms = {};
    for (const name of ['uViewProj', 'uCamPos', 'uAtlas', 'uFogColor', 'uFogDensity', 'uFlicker']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    this.decalProgram = buildProgram(gl, DECAL_VERTEX_SRC, DECAL_FRAGMENT_SRC);
    this.decalAttribs = {
      aPosition: gl.getAttribLocation(this.decalProgram, 'aPosition'),
      aUv: gl.getAttribLocation(this.decalProgram, 'aUv'),
      aShade: gl.getAttribLocation(this.decalProgram, 'aShade'),
    };
    this.decalUniforms = {};
    for (const name of ['uViewProj', 'uCamPos', 'uTexture', 'uFogDensity', 'uFlicker']) {
      this.decalUniforms[name] = gl.getUniformLocation(this.decalProgram, name);
    }

    this.atlasCanvas = buildAtlas();
    this.atlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas);
    // fract()-repeated atlas tiles cannot mipmap cleanly, so stay on LINEAR.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  /** Patches photo materials over the procedural atlas and re-uploads it. */
  applyMaterialImages(images: MaterialImages): void {
    patchAtlas(this.atlasCanvas, images);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas);
  }

  uploadChunk(vertices: Float32Array, indices: Uint16Array): ChunkMesh {
    const gl = this.gl;
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    return { vbo, ibo, indexCount: indices.length };
  }

  disposeChunk(mesh: ChunkMesh): void {
    this.gl.deleteBuffer(mesh.vbo);
    this.gl.deleteBuffer(mesh.ibo);
  }

  /** Replaces the dynamic mesh drawn after the chunks this frame. */
  setDynamicMesh(vertices: Float32Array, indices: Uint16Array): void {
    const gl = this.gl;
    this.dynVbo ??= gl.createBuffer();
    this.dynIbo ??= gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.dynIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
    this.dynCount = indices.length;
  }

  clearDynamicMesh(): void {
    this.dynCount = 0;
  }

  /**
   * Uploads (or re-uploads) the wall-writing texture from a canvas.
   * Uses texture unit 1 to avoid disturbing the wall atlas on unit 0.
   */
  setDecalTexture(source: HTMLCanvasElement): void {
    const gl = this.gl;
    this.decalTexture ??= gl.createTexture();
    // Upload on unit 1 (the decal pass's unit) so the wall atlas binding on
    // unit 0 is never disturbed - binding here on the active unit 0 replaced
    // the atlas with this mostly-transparent canvas and blacked the world out.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.decalTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Replaces the decal mesh (vertex layout: position(3), uv(2), shade(1)).
   * The decal pass draws wall writings as alpha-blended quads over the walls.
   */
  setDecalMesh(vertices: Float32Array, indices: Uint16Array): void {
    const gl = this.gl;
    this.decalVbo ??= gl.createBuffer();
    this.decalIbo ??= gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.decalVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.decalIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
    this.decalCount = indices.length;
  }

  clearDecalMesh(): void {
    this.decalCount = 0;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(chunks: Iterable<ChunkMesh>, camera: Camera, flicker: number): void {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(this.fogColor[0], this.fogColor[1], this.fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const viewProj = mat4Multiply(
      mat4Perspective(camera.fovY, aspect, 0.02, 80),
      mat4View(camera),
    );

    gl.uniformMatrix4fv(this.uniforms.uViewProj!, false, viewProj);
    gl.uniform3f(this.uniforms.uCamPos!, camera.x, camera.y, camera.z);
    gl.uniform3f(this.uniforms.uFogColor!, this.fogColor[0], this.fogColor[1], this.fogColor[2]);
    gl.uniform1f(this.uniforms.uFogDensity!, this.fogDensity);
    gl.uniform1f(this.uniforms.uFlicker!, flicker);
    gl.uniform1i(this.uniforms.uAtlas!, 0);

    // Re-assert the atlas on unit 0 every frame so no upload elsewhere can
    // leave the opaque pass sampling the wrong texture.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);

    for (const mesh of chunks) {
      this.drawMesh(mesh.vbo, mesh.ibo, mesh.indexCount);
    }
    if (this.dynCount > 0 && this.dynVbo && this.dynIbo) {
      this.drawMesh(this.dynVbo, this.dynIbo, this.dynCount);
    }
    this.drawDecals(viewProj, camera, flicker);
  }

  /** Alpha-blended wall-writing pass, drawn over the opaque geometry. */
  private drawDecals(viewProj: Float32Array, camera: Camera, flicker: number): void {
    if (this.decalCount === 0 || !this.decalVbo || !this.decalIbo || !this.decalTexture) {
      return;
    }
    const gl = this.gl;
    gl.useProgram(this.decalProgram);
    gl.uniformMatrix4fv(this.decalUniforms.uViewProj!, false, viewProj);
    gl.uniform3f(this.decalUniforms.uCamPos!, camera.x, camera.y, camera.z);
    gl.uniform1f(this.decalUniforms.uFogDensity!, this.fogDensity);
    gl.uniform1f(this.decalUniforms.uFlicker!, flicker);
    gl.uniform1i(this.decalUniforms.uTexture!, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.decalTexture);
    gl.activeTexture(gl.TEXTURE0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    // Stale arrays left enabled by the opaque pass can point past the small
    // decal buffer, which is an INVALID_OPERATION on strict implementations.
    for (const a of Object.values(this.attribs)) {
      gl.disableVertexAttribArray(a);
    }

    const stride = FLOATS_PER_DECAL_VERTEX * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.decalVbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.decalIbo);
    gl.vertexAttribPointer(this.decalAttribs.aPosition!, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(this.decalAttribs.aUv!, 2, gl.FLOAT, false, stride, 12);
    gl.vertexAttribPointer(this.decalAttribs.aShade!, 1, gl.FLOAT, false, stride, 20);
    for (const a of Object.values(this.decalAttribs)) {
      gl.enableVertexAttribArray(a);
    }
    gl.drawElements(gl.TRIANGLES, this.decalCount, gl.UNSIGNED_SHORT, 0);
    for (const a of Object.values(this.decalAttribs)) {
      gl.disableVertexAttribArray(a);
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  private drawMesh(vbo: WebGLBuffer, ibo: WebGLBuffer, indexCount: number): void {
    const gl = this.gl;
    const stride = FLOATS_PER_VERTEX * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.vertexAttribPointer(this.attribs.aPosition!, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(this.attribs.aUv!, 2, gl.FLOAT, false, stride, 12);
    gl.vertexAttribPointer(this.attribs.aTile!, 1, gl.FLOAT, false, stride, 20);
    gl.vertexAttribPointer(this.attribs.aTint!, 3, gl.FLOAT, false, stride, 24);
    gl.vertexAttribPointer(this.attribs.aShade!, 1, gl.FLOAT, false, stride, 36);
    for (const a of Object.values(this.attribs)) {
      gl.enableVertexAttribArray(a);
    }
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }
}

function buildProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader) ?? 'unknown'}`);
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? 'unknown'}`);
  }
  return program;
}

// --- Column-major mat4 helpers (only what the camera needs) -----------------

function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

/**
 * View matrix from camera position and yaw/pitch/roll. World axes: X east,
 * Y up, Z south (maze plane Y maps to world Z so north is -Z).
 */
function mat4View(camera: Camera): Float32Array {
  const rot = mat4Multiply(
    mat4RotateZ(-camera.roll),
    mat4Multiply(mat4RotateX(-camera.pitch), mat4RotateY(-camera.yaw)),
  );
  const trans = mat4Identity();
  trans[12] = -camera.x;
  trans[13] = -camera.y;
  trans[14] = -camera.z;
  return mat4Multiply(rot, trans);
}

function mat4Identity(): Float32Array {
  const out = new Float32Array(16);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

function mat4RotateX(rad: number): Float32Array {
  const out = mat4Identity();
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  out[5] = c;
  out[6] = s;
  out[9] = -s;
  out[10] = c;
  return out;
}

function mat4RotateY(rad: number): Float32Array {
  const out = mat4Identity();
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  out[0] = c;
  out[2] = -s;
  out[8] = s;
  out[10] = c;
  return out;
}

function mat4RotateZ(rad: number): Float32Array {
  const out = mat4Identity();
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  out[0] = c;
  out[1] = s;
  out[4] = -s;
  out[5] = c;
  return out;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row]! * b[col * 4 + k]!;
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
