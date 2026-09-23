# Internal CA certificates

Drop PEM-encoded CA certificates (`*.crt` or `*.pem`) in this folder, or
point `CA_CERT_DIR` in `docker/.env` at another folder, then rebuild:

```bash
npm run docker:build
```

They are appended to the image's system CA bundle before any network access,
so `apk add`, `npm ci`, `git clone`/`fetch` and Node's HTTPS calls (AI
endpoint, GitHub/GitLab APIs) all trust them. Certificate files here are
git-ignored.
