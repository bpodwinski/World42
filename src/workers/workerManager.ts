/**
 * Creates new worker instance using provided scriptURL
 *
 * @param {string} scriptURL - scriptURL of worker script
 * @returns {Worker} New Worker instance
 */
export function createWorker(scriptURL: string): Worker {
    return new Worker(scriptURL, { type: "module" });
}
