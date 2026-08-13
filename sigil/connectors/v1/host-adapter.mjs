export function createHostAdapter({ connector, runtime }) {
  if (!connector) throw new Error('connector is required');
  return Object.freeze({
    runtime,
    async sendTask(task) { return connector.sendTask(task); },
    async checkInbox() { return connector.checkInbox(); },
    async getResult(taskId) { return connector.getResult(taskId); },
    async requestApproval(action) { return connector.requestApproval(action); },
    async resolveContext(ref) { return connector.resolveContext(ref); }
  });
}
