import type { Env } from "../env";
import { ApiHttpError } from "../http/errors";
import type { GitHubRepository } from "./client";

export function validateTemplateRepository(env: Env, repository: GitHubRepository): void {
  const templateId = env.GITHUB_TEMPLATE_REPO_ID
    ? Number(env.GITHUB_TEMPLATE_REPO_ID)
    : null;
  const template = env.GITHUB_TEMPLATE_REPO;
  const wrongTemplateId =
    templateId !== null &&
    Number.isSafeInteger(templateId) &&
    repository.sourceRepositoryId !== templateId;
  const wrongTemplateName =
    templateId === null && template && repository.parentFullName !== template;
  if (wrongTemplateId || wrongTemplateName) {
    throw new ApiHttpError(
      403,
      "forbidden",
      `Repository must be a fork of the course template ${template}.`,
    );
  }
}
