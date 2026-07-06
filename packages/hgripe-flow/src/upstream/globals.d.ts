// The vendored upstream source guards dev-only warnings with
// `process.env.NODE_ENV`; Vite statically replaces it at build time.
declare const process: { env: { NODE_ENV?: string } };
