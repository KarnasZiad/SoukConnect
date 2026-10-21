import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInternalVerifier, createLogger, signInternalToken } from '@soukconnect/service-kit';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { buyer, buyerId, keys, sellerId } from '../../test/fakes.js';
import { startRealtime } from './socket.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server() {
  const { signing, publicKeys } = await keys();
  const http = createServer();
  const realtime = startRealtime(http, {
    verifyTicket: createInternalVerifier({ audience: 'notifications', publicKeys }),
    logger: createLogger('socket-test', 'silent'),
    publicOrigin: 'https://soukconnect.test',
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => realtime.io.close());
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const client = (ticket: unknown): Socket => {
    const socket = connect(url, {
      path: '/socket.io',
      auth: { ticket },
      transports: ['websocket'],
      reconnection: false,
    });
    cleanups.push(() => {
      socket.close();
    });
    return socket;
  };
  return { realtime, client, signing };
}

/** "connected", or the reason the server refused the socket. */
function outcome(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.on('connect', () => {
      resolve('connected');
    });
    socket.on('connect_error', (error) => {
      resolve(error.message);
    });
  });
}

describe('real-time delivery', () => {
  it('delivers events to every tab of the account, and to no one else', async () => {
    const { realtime, client, signing } = await server();
    const ticket = (userId: string) =>
      signInternalToken(signing, 'notifications', { ...buyer, userId }, 60);
    const tabs = [client(await ticket(buyerId)), client(await ticket(buyerId))];
    const stranger = client(await ticket(sellerId));
    await Promise.all([...tabs, stranger].map(outcome));

    const received: unknown[] = [];
    for (const tab of tabs) tab.on('notification', (payload: unknown) => received.push(payload));
    let leaked = false;
    stranger.on('notification', () => {
      leaked = true;
    });
    realtime.push.toUser(buyerId, 'notification', { type: 'order-shipped' });

    await expect.poll(() => received.length).toBe(2);
    expect(received[0]).toEqual({ type: 'order-shipped' });
    expect(leaked).toBe(false);
  });

  it('refuses a socket without a valid ticket, or for a visitor', async () => {
    const { client, signing } = await server();

    expect(await outcome(client(undefined))).toBe('A ticket is required');
    expect(await outcome(client('forged.ticket.value'))).toBe('Invalid or expired ticket');
    const forOrders = await signInternalToken(signing, 'orders', buyer);
    expect(await outcome(client(forOrders))).toBe('Invalid or expired ticket');
    const visitor = await signInternalToken(signing, 'notifications', {
      userId: null,
      role: 'visitor',
      shopId: null,
    });
    expect(await outcome(client(visitor))).toBe('Sign in first');
  });
});
