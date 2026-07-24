/** Shared placeholder for stubbed on-chain functions. */
export const NOT_IMPLEMENTED = (where: string): never => {
  throw new Error(`Not implemented yet: ${where}`);
};
