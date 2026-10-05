// Stand-in for capnweb-validate decorators, which need a compiler transform not available
// under plain vitest. The decorators are no-ops here; runtime validation belongs in
// Workers-pool tests, not these Node stub tests.

export function validateRpc(): ClassDecorator {
  return () => undefined;
}

export function skipRpcValidation(): MethodDecorator {
  return () => undefined;
}
