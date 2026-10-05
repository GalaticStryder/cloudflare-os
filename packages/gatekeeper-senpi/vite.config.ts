// Vite+ per-package settings. The `test` task runs both vitest projects: pure-logic tests in Node
// and the RpcTarget/DurableObject suite in workerd. The passes stay separate commands so one can
// replay from the task cache when only the other's inputs moved.
import { withVitestTask } from '../../scripts/vitest-task-vite-config.js'

export default withVitestTask({}, [
  "vitest run",
  "vitest run --config vitest.worker.config.ts",
])
