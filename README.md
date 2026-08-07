# Permission Next

Static dashboard for Cloudflare Pages.

## Deploy to Cloudflare Pages

1. Push this folder to `Kobpatme/Permission_Next.git`.
2. In Cloudflare Pages, connect the repository.
3. Use these build settings:
   - Framework preset: `None`
   - Build command: leave empty
   - Build output directory: `/`
4. Open the deployed site root. `index.html` redirects to `Permission_Next.html`.

## Production Files

- `Permission_Next.html` - main application
- `index.html` - root entry point for Cloudflare Pages
- `_headers` - basic HTTP headers for the static site

`permission_master.xlsx` and `Test.html` are ignored by git so local source/test files do not get published accidentally.

## Basic Login

The app includes a basic in-app login gate backed by the existing Firestore `buildings` collection, using the hidden document `permission_next_auth`. On first load, it seeds this admin account if missing:

- ID: `admin101@uih.co.th`
- Password: `admin101`
- Role: `admin`

Roles:

- `admin` - manage buildings and users
- `permission` - manage buildings
- `sale` - view/search buildings and create preliminary quotations

## Building Documents on NAS

The building detail dialog includes a Documents tab for `admin` and `permission` users. The local development server searches building folders through the region folders under:

`P:\BBG\Outside Plant&Coordination\!!!_Data Base Building Drawing`

Supported categories are DWG (`.dwg`), PDF (`.pdf`), and images (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.tif`, `.tiff`, `.bmp`, `.heic`, `.heif`). The document feature does not read from or write to Firestore. It searches automatically when a building is opened and keeps the result only in the current browser page's memory. File categories start collapsed and their rows are created only when expanded, keeping large building folders responsive. Folder names and NAS paths are not sent to the browser. Each matched file is exposed through a short-lived opaque download token restricted to supported files inside the configured NAS root.

Run locally on a Windows machine that has the team drive mapped as `P:`:

```powershell
node dev-server.js
```

Then open `http://127.0.0.1:8766`. Opening a building automatically asks the local NAS bridge to locate matching files by Thai/English name and Area. The UI exposes only file information and Download links; it does not expose folder selection, folder paths, or path-copy controls.

The browser login is still a lightweight client-side access layer. The NAS ACL must independently restrict the source folder to the Admin/Permission groups.

This is a lightweight client-side access layer, not a replacement for server-side security rules.
