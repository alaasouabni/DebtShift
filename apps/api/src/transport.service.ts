import { DeterministicTransportSimulator, transportQuoteRequestSchema } from '@debtshift/intents';
import { Injectable } from '@nestjs/common';

@Injectable()
export class TransportService {
  readonly #simulator = new DeterministicTransportSimulator();

  getQuote(input: unknown) {
    return this.#simulator.getQuote(transportQuoteRequestSchema.parse(input));
  }
}
