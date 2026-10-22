import { DockerAdapter } from './docker.js';

// Identical to DockerAdapter; the only difference is that the nodeUrl points
// at a remote hosted TWIN Node rather than localhost. We refuse to default,
// since "hosted" implies an explicit deployment target. T-209 will populate
// the config from env vars (TWIN_NODE_URL etc.).
export class HostedAdapter extends DockerAdapter {
  get mode() { return 'hosted'; }

  async init(config) {
    if (!config?.nodeUrl) {
      throw new Error('HostedAdapter.init: config.nodeUrl is required (no localhost default)');
    }
    if (/^https?:\/\/(localhost|127\.|\[?::1\]?)/i.test(config.nodeUrl)) {
      throw new Error(`HostedAdapter.init: nodeUrl points at localhost (${config.nodeUrl}); use DockerAdapter instead`);
    }
    return super.init(config);
  }
}
