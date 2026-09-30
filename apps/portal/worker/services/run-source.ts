/**
 * Whether a recorded source is still the repository the team is connected to.
 *
 * Its own module because both the mutation services and the snapshot builder
 * need it, and those two already import each other. One spelling of the rule,
 * imported by everything that asks the question, is also what stops the server
 * refusing an action a client was still offering.
 */

/** A team has one connected repository and every write is authorised against
 *  it, so a new promotion, rerun, verification or publication has to be about
 *  that repository.
 *
 *  Matched on the id: GitHub keeps it through a rename, so a renamed
 *  repository keeps working, while a repository the team has since left, or a
 *  run from before the id was recorded, cannot be authorised by the permission
 *  we can check.
 *
 *  Reading history is untouched, and so is a result already published. This
 *  only refuses new mutations. */
export function runSourceRefusal(
  team: { repoId: number | null; repoFullName: string },
  source: { repositoryId: number | null } | null | undefined,
  action: string,
): string | null {
  if (source && source.repositoryId !== null && source.repositoryId === team.repoId) return null;
  const connected = team.repoFullName;
  return !source || source.repositoryId === null
    ? `This run predates the repository CogPortal records, so it cannot tell whether it came from ${connected}. Start a fresh run there to ${action}.`
    : `This run came from a repository your team is no longer connected to. Start a fresh run on ${connected} to ${action}.`;
}
