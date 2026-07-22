# Canonical template catalog

Student projects remain separate GitHub repositories and are forked from a
small canonical template for each benchmark. They are not Git submodules or
copies in this monorepo.

Before enabling a template in production, add its immutable numeric GitHub
repository ID and a reviewed 40-character revision to `catalog.json`, then run:

```sh
python3 template-catalog/validate.py
```

The catalog is deliberately empty until the course-owned repositories exist;
the portal fails closed when `GITHUB_TEMPLATE_REPO_ID` is configured and the
connected repository is not in that fork network.

An interface-only local candidate is prepared at
`../week2-vision-capstone`. Do not add a placeholder catalog record: publish and
review the course-owned GitHub repository first so its numeric ID and revision
are real and immutable.
