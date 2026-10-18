import type { FastifyRequest } from "fastify";

/**
 * v1 has a single development owner. Replace `resolveOwnerId` with real session /
 * token lookup when auth lands; every query that scopes by owner goes through here.
 */
export interface AuthContext {
  ownerId: string;
}

export function createAuth(devOwnerId: string) {
  return {
    resolve(_req: FastifyRequest): AuthContext {
      return { ownerId: devOwnerId };
    },
  };
}
export type Auth = ReturnType<typeof createAuth>;
