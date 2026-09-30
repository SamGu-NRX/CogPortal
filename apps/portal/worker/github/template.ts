import type { Env } from "../env";
import { ApiHttpError } from "../http/errors";
import type { GitHubRepository } from "./client";

export function validateTemplateRepository(env: Env, repository: GitHubRepository): void {
  const templateId = env.GITHUB_TEMPLATE_REPO_ID
    ? Number(env.GITHUB_TEMPLATE_REPO_ID)
    : null;
  const wrongTemplateId =
    templateId !== null &&
    Number.isSafeInteger(templateId) &&
    repository.sourceRepositoryId !== templateId;
  // Only the ID restricts ancestry. GITHUB_TEMPLATE_REPO is the name on the
  // fork button, and it used to reject every repository that was not a fork of
  // it, so naming a template to offer the on-ramp locked out the creative
  // projects the course is for.
  if (wrongTemplateId) {
    const template = env.GITHUB_TEMPLATE_REPO;
    throw new ApiHttpError(
      403,
      "forbidden",
      template
        ? `This cohort only accepts forks of ${template}, and this repository isn't one. Fork that template and connect the fork.`
        : "This cohort only accepts forks of its course template, and this repository isn't one. Ask your instructor which template to fork.",
    );
  }
}
