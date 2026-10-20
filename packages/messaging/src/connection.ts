import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib';
import type { Logger } from './logger.js';

export interface BrokerOptions {
  url: string;
  /** Shown in the RabbitMQ console: which service holds the connection. */
  name: string;
  logger: Logger;
  /**
   * Called when the connection or the channel is lost unexpectedly. The default stops the
   * process: the orchestrator restarts it and unacknowledged messages are delivered again, which
   * is simpler and safer than rebuilding every consumer in place.
   */
  onLost?: (error: unknown) => void;
}

export interface Broker {
  connection: ChannelModel;
  /** Confirm channel shared by the relay and the consumers of the service. */
  channel: ConfirmChannel;
  close(): Promise<void>;
}

export async function connectBroker(options: BrokerOptions): Promise<Broker> {
  const { logger } = options;
  const onLost =
    options.onLost ??
    ((error: unknown) => {
      logger.error({ err: error }, 'broker connection lost: exiting so that the service restarts');
      process.exit(1);
    });
  let closing = false;

  const connection = await connect(options.url, {
    clientProperties: { connection_name: options.name },
  });
  connection.on('error', (error: Error) => {
    logger.error({ err: error }, 'broker connection error');
  });
  connection.on('close', (error?: Error) => {
    if (!closing) onLost(error ?? new Error('Broker connection closed'));
  });

  const channel = await connection.createConfirmChannel();
  channel.on('error', (error: Error) => {
    logger.error({ err: error }, 'broker channel error');
  });
  channel.on('close', () => {
    if (!closing) onLost(new Error('Broker channel closed'));
  });

  return {
    connection,
    channel,
    async close() {
      closing = true;
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
    },
  };
}
