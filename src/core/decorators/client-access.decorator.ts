import { SetMetadata } from '@nestjs/common';

export const CLIENT_ACCESS_KEY = 'clientAccess';

/**
 * Marks a route used by the client portal whose service limits CLIENT users to their own
 * client's records. CLIENT users may call such a route without holding its @Permissions.
 * Without this marker, CLIENT users need the route's permissions like any other role.
 * Only add it after confirming the service scopes CLIENT callers.
 */
export const ClientAccess = () => SetMetadata(CLIENT_ACCESS_KEY, true);
