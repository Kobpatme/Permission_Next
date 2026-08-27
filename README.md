# Permission Next

Static dashboard for Cloudflare Pages.

## Windows Desktop

The desktop edition uses Electron and starts its local NAS bridge on a free loopback port assigned by Windows.
Only one app instance runs at a time, and the window opens after the bridge is ready.
Building and user data are synchronized through Firestore snapshot listeners. Cached data
remains available during a temporary disconnect and the listener reconnects automatically.

```powershell
npm test
npm run dist
```

The primary Windows build is a per-user NSIS installer in `dist-installer`. Only Thai and English Electron
locales are packaged to keep the delivery smaller. The NAS folder index is loaded lazily when
a user opens the Documents tab, so normal startup does not scan the shared drive. A fallback
portable executable can still be built with `npm run dist:portable`; portable builds do not use
the automatic updater.

## Desktop Updates

The installer build uses `electron-updater` with GitHub Releases at
`https://github.com/Kobpatme/Permission_Next/releases/latest/download/` as its default generic
release server. Pass another release-folder URL as the first argument to the build command, or set
`PERMISSION_NEXT_UPDATE_URL` before running `npm run dist`, to override it. The URL is written into
the packaged installer configuration and is not requested from end users.

Each release must increase the `version` in `package.json`. After building, upload these generated
files from `dist-installer` to the matching GitHub Release:

- `latest.yml`
- `Permission_Next_Setup_v<version>.exe`
- `Permission_Next_Setup_v<version>.exe.blockmap`

Installed clients check for updates shortly after launch. New releases download in the
background; users can monitor progress from **เมนูบัญชี > อัปเดตโปรแกรม** and choose
**รีสตาร์ตและติดตั้ง** when ready. A downloaded update is also installed when the app exits.
Use HTTPS and code-sign production installers. Restrict write access to the release folder so
only the release administrator can replace update metadata or installers.

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

The app keeps the existing in-app login gate backed by the Firestore `buildings` collection, using the hidden document `permission_next_auth`. It does not create a default administrator. An existing administrator must create and manage accounts. The last successful user ID is remembered locally, while the active session is stored only in session storage and expires after 12 hours.

New and changed passwords use PBKDF2-SHA256 with an individual random salt and 210,000 iterations. A successful login upgrades an older legacy SHA-256 password hash automatically. Plain-text passwords are never stored locally.

Roles:

- `admin` - manage buildings and users
- `permission` - manage buildings
- `sale` - view/search buildings and create preliminary quotations

## Building Documents on NAS

The building detail dialog includes a Documents tab for `admin` and `permission` users. The local development server searches building folders through the region folders under:

`P:\BBG\Outside Plant&Coordination\!!!_Data Base Building Drawing`

Supported categories are DWG (`.dwg`), PDF (`.pdf`), and images (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.tif`, `.tiff`, `.bmp`, `.heic`, `.heif`). The document feature does not read from or write to Firestore. It searches automatically when a building is opened and keeps the result only in the current browser page's memory. File categories start collapsed and their rows are created only when expanded, keeping large building folders responsive. Folder names and NAS paths are not sent to the browser. Each matched file is exposed through a short-lived opaque download token restricted to supported files inside the configured NAS root. Users with the per-account `can_upload_documents` permission can add files (up to 100 MB each) to the matched building folder; existing files are never overwritten.

Run locally on a Windows machine that has the team drive mapped as `P:`:

```powershell
node dev-server.js
```

Then open the loopback URL printed by the server (normally `http://127.0.0.1:8766` when run manually). Opening a building automatically asks the local NAS bridge to locate matching files by Thai/English name and Area. The UI exposes only file information, Download links, and inline Preview links for PDFs and images; it does not expose folder selection, folder paths, or path-copy controls.

The Admin user management dialog controls the per-account `can_upload_documents` permission. The embedded Electron NAS bridge requires a per-launch random bearer token, serves only an explicit web-file allowlist, and enables uploads only for the desktop process. The temporary LAN-share script also generates a random access link, but starts in read-only mode. Do not forward that link outside the trusted network.

### Use NAS documents from the deployed Cloudflare Pages site

Cloudflare cannot read a Windows mapped drive. Each team PC that needs the Documents tab must therefore run the local bridge while using the deployed site:

1. Keep the bridge package on the PC and install Node.js.
2. Double-click `install-nas-bridge-startup.cmd` once for each Windows user. It creates a current-user Startup shortcut and starts the bridge immediately without requiring administrator rights. Use `start-nas-bridge.cmd` when you only want to start it for the current Windows session.
3. Ask IT to run `install-nas-browser-policy-admin.cmd` once per PC as administrator, or deploy the same policy by Group Policy. The installer adds only `https://permission-next.pages.dev` to `LocalNetworkAccessAllowedForUrls` for Chrome and Microsoft Edge; it preserves any existing policy list values.
4. Close and reopen the browser, then open `https://permission-next.pages.dev/Permission_Next` normally. The deployed app discovers the background bridge at `http://127.0.0.1:8766` automatically; users do not open the localhost app.

The bridge is bound to loopback only, supports CORS/Private Network preflight, and accepts the production origin `https://permission-next.pages.dev` plus its Cloudflare preview subdomains. Other web origins receive HTTP 403. If the deployed site uses a custom domain, start the bridge with that exact origin in `NAS_BRIDGE_ALLOWED_ORIGINS`, for example:

```powershell
$env:NAS_BRIDGE_ALLOWED_ORIGINS='https://permission.example.com'
node dev-server.js
```

Download links use short-lived opaque tokens and never expose the mapped-drive path to the deployed page.

The Documents tab is shown to signed-in `admin` and `permission` roles. Document requests succeed only when the local bridge is installed and the Windows account running it can read the configured NAS root. The mapped-drive ACL remains the authority for file access.

The browser login is still a lightweight client-side access layer because this project intentionally does not use Firebase Authentication. The NAS ACL must independently restrict the source folder to the Admin/Permission groups.

This is a lightweight client-side access layer, not a replacement for server-side security rules.
