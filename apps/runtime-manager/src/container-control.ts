export interface ContainerControl {
  stop(timeoutS: number): Promise<void>;
  start(): Promise<void>;
  isRunning(): Promise<boolean>;
}

/** Real Docker implementation using dockerode. */
export class DockerContainerControl implements ContainerControl {
  constructor(
    private readonly docker: import("dockerode"),
    private readonly containerName: string,
  ) {}

  async stop(timeoutS: number): Promise<void> {
    const container = this.docker.getContainer(this.containerName);
    await container.stop({ t: timeoutS });
  }

  async start(): Promise<void> {
    const container = this.docker.getContainer(this.containerName);
    await container.start();
  }

  async isRunning(): Promise<boolean> {
    try {
      const container = this.docker.getContainer(this.containerName);
      const info = await container.inspect();
      return info.State.Running;
    } catch {
      return false;
    }
  }
}

/** In-memory stub for testing. */
export class MockContainerControl implements ContainerControl {
  running = true;
  stopCalls: number[] = [];
  startCalls = 0;

  async stop(timeoutS: number): Promise<void> {
    this.stopCalls.push(timeoutS);
    this.running = false;
  }

  async start(): Promise<void> {
    this.startCalls++;
    this.running = true;
  }

  async isRunning(): Promise<boolean> {
    return this.running;
  }
}
