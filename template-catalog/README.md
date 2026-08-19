# Canonical template catalog

Student teams fork a template repository; their work stays in their own repo
and is never a submodule or a copy in this monorepo. This file records which
repository and which commit each benchmark's template is pinned to.

`SamGu-NRX/cogworks-capstone-template` serves all four benchmarks, because a
team keeps all three weeks in one repository. That is what one of last year's
groups did unprompted, and it is what the course's own advice implies: "you
guys are going to be working on the same code base." So four entries share
one `sourceRepositoryId`, and the validator requires them to pin the same
commit, since a student forking for Week 2 should get the same starting point
as the teammate who forked for Week 1.

## Changing the pinned commit

Push to the template repository, then:

```sh
sha=$(gh api repos/SamGu-NRX/cogworks-capstone-template/commits/main --jq .sha)
# update every "revision" in catalog.json to $sha
python3 template-catalog/validate.py
```

The portal fails closed when `GITHUB_TEMPLATE_REPO_ID` is configured and a
connected repository is not in that fork network. Leaving it unset means the
check passes for any repository, which is the right default while teams from
before the template existed still need to connect.

## Enabling fork enforcement

Set `GITHUB_TEMPLATE_REPO_ID` to `1339633157` in the wrangler environment.
Do this only once every team has forked; turning it on early locks out the
2026 repositories, none of which descend from this template.
