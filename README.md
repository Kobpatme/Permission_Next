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

The app includes a basic in-app login gate backed by the existing Firestore database. On first load, it seeds this admin account if missing:

- ID: `admin101@uih.co.th`
- Password: `admin101`
- Role: `admin`

Roles:

- `admin` - manage buildings and users
- `permission` - manage buildings
- `sale` - view/search buildings and create preliminary quotations

This is a lightweight client-side access layer, not a replacement for server-side security rules.
