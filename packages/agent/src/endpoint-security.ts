import { lookup as defaultLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type DnsLookup = typeof defaultLookup;

export interface ResolvedPublicAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export function parseRemoteBaseUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:') throw new Error('Remote AI endpoints must use HTTPS.');
  assertCleanBaseUrl(url);
  assertPublicIpLiteral(url.hostname);
  return url;
}

export function parseLocalOllamaBaseUrl(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The Ollama endpoint must use HTTP or HTTPS.');
  }
  assertCleanBaseUrl(url);
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('Local Ollama must use a loopback hostname.');
  }
  return url;
}

export async function assertPublicRemoteEndpoint(
  url: URL,
  lookup: DnsLookup = defaultLookup,
): Promise<void> {
  await resolvePublicRemoteAddress(url, lookup);
}

export async function resolvePublicRemoteAddress(
  url: URL,
  lookup: DnsLookup = defaultLookup,
): Promise<ResolvedPublicAddress> {
  const hostname = stripIpv6Brackets(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isNonPublicIp(hostname)) throw new Error('Remote AI endpoint resolved to a non-public IP.');
    return { address: hostname, family: literalFamily === 4 ? 4 : 6 };
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isNonPublicIp(record.address))) {
    throw new Error('Remote AI endpoint DNS includes a non-public or missing address.');
  }
  const selected = records[0];
  if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error('Remote AI endpoint DNS returned an unsupported address.');
  }
  return { address: selected.address, family: selected.family };
}

export function isNonPublicIp(input: string): boolean {
  const address = stripIpv6Brackets(input).toLowerCase();
  const version = isIP(address);
  if (version === 4) return isNonPublicIpv4(address);
  if (version !== 6) return true;
  const bytes = parseIpv6(address);
  if (bytes === undefined) return true;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;
  // DebtShift remote providers need ordinary globally routed unicast. Reject
  // loopback, mapped, NAT64, ULA, link-local, multicast, documentation,
  // benchmarking, transition, and every other non-2000::/3 address.
  if ((first & 0xe0) !== 0x20) return true;
  if (first === 0x20 && second === 0x01 && third <= 0x01) return true;
  if (first === 0x20 && second === 0x01 && third === 0x0d && fourth === 0xb8) {
    return true;
  }
  if (first === 0x20 && second === 0x02) return true;
  return false;
}

function isNonPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [first = -1, second = -1, third = -1] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return true;
  if (first === 192 && second === 88 && third === 99) return true;
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  return false;
}

function assertPublicIpLiteral(hostname: string): void {
  const unwrapped = stripIpv6Brackets(hostname);
  if (isIP(unwrapped) !== 0 && isNonPublicIp(unwrapped)) {
    throw new Error('Remote AI endpoints cannot use non-public IP literals.');
  }
}

function assertCleanBaseUrl(url: URL): void {
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('AI endpoint URLs cannot contain credentials.');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('AI endpoint base URLs cannot contain a query or fragment.');
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function parseIpv6(input: string): Uint8Array | undefined {
  if (input.includes('%')) return undefined;
  let address = input;
  const dottedTail = address.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail !== undefined) {
    const octets = dottedTail.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return undefined;
    }
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, -dottedTail.length)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] === '' ? [] : (halves[0]?.split(':') ?? []);
  const right = halves.length === 1 || halves[1] === '' ? [] : (halves[1]?.split(':') ?? []);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) =>
    /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : Number.NaN,
  );
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word))) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}
