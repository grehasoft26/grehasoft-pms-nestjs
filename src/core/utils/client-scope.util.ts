/**
 * Resolves the client record a CLIENT portal user belongs to.
 *
 * The canonical link is users.client_id (the Client.portal_users relation). For older portal
 * users without that link, the email is used only when exactly one active client has it.
 * Returns null when the client cannot be determined; callers must then deny access.
 * Never match on client.id === user.id: user and client ids are unrelated sequences.
 */
export async function resolveClientForUser(
  prisma: { client: { findFirst: (args: any) => Promise<any>; findMany: (args: any) => Promise<any[]> } },
  user: { client_id?: number | null; email?: string | null } | null | undefined,
): Promise<any | null> {
  if (!user) return null;
  if (user.client_id) {
    return prisma.client.findFirst({ where: { id: user.client_id, deleted_at: null } });
  }
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  if (!email) return null;
  const matches = await prisma.client.findMany({ where: { email, deleted_at: null }, take: 2 });
  return matches.length === 1 ? matches[0] : null;
}
