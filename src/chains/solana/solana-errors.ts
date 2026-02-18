import { FastifyInstance } from 'fastify';

/**
 * Handle common Solana transaction errors and map them to appropriate HTTP errors
 * @param fastify Fastify instance for error responses
 * @param error The error to handle
 * @param operation Description of the operation that failed (e.g., 'wrap SOL to WSOL')
 */
export function handleSolanaTransactionError(fastify: FastifyInstance, error: any, operation: string): never {
  // Re-throw errors that already have statusCode (our custom errors)
  if (error.statusCode) {
    throw error;
  }

  const message = error.message || '';

  // Map common error patterns to appropriate HTTP errors
  if (message.includes('insufficient funds')) {
    throw fastify.httpErrors.badRequest(
      `Insufficient funds for transaction. Please ensure you have enough SOL to ${operation} and pay for transaction fees.`,
    );
  }

  if (message.includes('timeout')) {
    throw fastify.httpErrors.requestTimeout(
      `Transaction timeout. The transaction may still be pending. Signature: ${error.signature || 'unknown'}`,
    );
  }

  if (message.includes('rejected on Ledger')) {
    throw fastify.httpErrors.badRequest('Transaction rejected on Ledger device');
  }

  if (message.includes('Ledger device is locked') || message.includes('Wrong app is open')) {
    throw fastify.httpErrors.badRequest(message);
  }

  // Default to internal server error for unknown errors
  throw fastify.httpErrors.internalServerError(`Failed to ${operation}: ${message}`);
}
