# GitHub Pages Setup

This document explains how to enable GitHub Pages for the BackViews browser demo.

## Enable GitHub Pages

To deploy the browser demo to GitHub Pages, you need to configure the repository settings:

1. Go to your repository on GitHub: `https://github.com/isocialPractice/vscode-backviews`
2. Click **Settings** (top navigation)
3. In the left sidebar, click **Pages** (under "Code and automation")
4. Under **Source**, select **GitHub Actions**
5. Save the changes

## Deployment Workflow

The GitHub Actions workflow (`.github/workflows/deploy-pages.yml`) automatically:

1. Triggers on push to `main` branch or manual workflow dispatch
2. Checks out both `vscode-backviews` and `cmd-backedges` repositories
3. Sets up Node.js 20
4. Installs dependencies with `npm install`
5. Builds the webview bundle with `npm run build`
6. Prepares deployment directory with:
   - `index.html` (browser game launcher)
   - `media/` folder (webview.js bundle, logo, icon)
   - `materials/` folder (wallpaper, ceiling, carpet textures)
6. Deploys to GitHub Pages

## Verify Deployment

After pushing to `main`:

1. Go to the **Actions** tab in your repository
2. Click on the most recent "Deploy to GitHub Pages" workflow run
3. Wait for both **build** and **deploy** jobs to complete (green checkmarks)
4. Visit the live demo at: `https://isocialpractice.github.io/vscode-backviews/`

## Manual Deployment

To manually trigger the deployment without pushing code:

1. Go to the **Actions** tab
2. Click "Deploy to GitHub Pages" in the left sidebar
3. Click **Run workflow** button (top right)
4. Select the `main` branch
5. Click **Run workflow**

## Troubleshooting

**Pages not deploying:**
- Verify GitHub Pages source is set to "GitHub Actions" in repository settings
- Check that the workflow has proper permissions (set in the workflow file)
- Review the Actions workflow logs for error messages

**Build fails:**
- Ensure `cmd-backedges` repository exists and is accessible
- Check that Node.js version is 18 or newer (workflow uses Node 20)
- Verify `package.json` and dependencies are correct

**Note on caching:**
- The workflow does not use npm caching to avoid path resolution issues
- This ensures reliable builds without cache dependency errors
- Build time is acceptable without caching for this project size

**Game doesn't load on Pages:**
- Open browser console (F12) for error messages
- Verify `media/webview.js` was built and deployed
- Check that `materials/` folder contains texture files
- Ensure paths in `index.html` are relative (not absolute)

## Local Testing

Before deploying, test the browser version locally:

```bash
# Build the webview bundle
npm install
npm run build

# Start a local web server
php -S localhost:9090

# Open in browser
# http://localhost:9090
```

The browser demo should work identically on localhost and GitHub Pages.
