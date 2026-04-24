/**
 * Lambda entry point.
 *
 * A thin re-export so the handler path contains no dots other than the final
 * `.handler` method suffix. The nodejs20.x Lambda runtime splits the handler
 * string on the FIRST dot to determine the module file, so a filename like
 * `snapshot.handler.js` would cause it to resolve `snapshot` as the module
 * name and fail with "Cannot find module 'snapshot'".
 *
 * Terraform handler: "lambda/index.handler"
 *   → module: /var/task/lambda/index.js   (unambiguous)
 *   → export: handler
 */
export { handler } from './snapshot.handler.js';
