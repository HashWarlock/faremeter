import "dotenv/config";
import { logger } from "../logger";
import { default as express } from "express";
import { createMiddleware } from "@faremeter/middleware/express";
import { isAddress, Address } from "@faremeter/types/evm";
import { x402Exact } from "@faremeter/info/evm";

// TypeScript interfaces for Redpill AI API
interface RedpillChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface RedpillSignatureResponse {
  request_id: string;
  model: string;
  signature?: {
    algorithm: string;
    curve: string;
    value: string;
    public_key: string;
    message_hash: string;
  };
  payload?: {
    request_hash: string;
    response_hash: string;
    timestamp: string;
    model: string;
    tee_instance: string;
  };
  cert_chain?: string[];
}

const { EVM_RECEIVING_ADDRESS, PORT, REDPILL_API_KEY } = process.env;

const payTo = EVM_RECEIVING_ADDRESS as Address;

if (!isAddress(payTo)) {
  throw new Error(
    "EVM_RECEIVING_ADDRESS must be set in your environment, and be a valid EVM address",
  );
}

if (!REDPILL_API_KEY) {
  logger.warn(
    "REDPILL_API_KEY not set in environment. The /tee-demo endpoint will not function.",
  );
}

const network = "base-sepolia";
const port = PORT ? parseInt(PORT) : 4021;

const run = async () => {
  const app = express();

  app.get(
    "/weather",
    await createMiddleware({
      facilitatorURL: "http://localhost:4000",
      accepts: [
        x402Exact({
          network,
          asset: "USDC",
          payTo,
          amount: "10000", // 0.01 USDC
        }),
      ],
    }),
    (_, res) => {
      res.json({
        temperature: 72,
        conditions: "sunny",
        message: "Thanks for your payment!",
      });
    },
  );

  app.get(
    "/tee-demo",
    await createMiddleware({
      facilitatorURL: "http://localhost:4000",
      accepts: [
        x402Exact({
          network,
          asset: "USDC",
          payTo,
          amount: "10000", // 0.01 USDC
        }),
      ],
    }),
    async (_, res) => {
      try {
        if (!REDPILL_API_KEY) {
          logger.error("REDPILL_API_KEY not configured");
          return res.status(500).json({
            error: "Service configuration error",
            message: "REDPILL_API_KEY not configured in environment",
          });
        }

        logger.info("Starting TEE verification demo");

        // Step 1: Call Redpill AI chat completions API
        logger.info("Calling Redpill AI chat completions API");
        const chatResponse = await fetch(
          "https://api.redpill.ai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${REDPILL_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "phala/qwen-2.5-7b-instruct",
              messages: [{ role: "user", content: "Hello" }],
            }),
          },
        );

        if (!chatResponse.ok) {
          const errorText = await chatResponse.text();
          logger.error(
            `Chat API failed with status ${chatResponse.status}: ${errorText}`,
          );
          throw new Error(
            `Chat API failed: ${chatResponse.status} ${chatResponse.statusText}`,
          );
        }

        const chatData: RedpillChatResponse = await chatResponse.json();
        const requestId = chatData.id;
        logger.info(`Chat completion successful, request_id: ${requestId}`);

        // Step 2: Fetch TEE signature for the request
        logger.info(`Fetching TEE signature for request_id: ${requestId}`);
        const signatureUrl = `https://api.redpill.ai/v1/signature/${requestId}?model=phala/qwen-2.5-7b-instruct&signing_algo=ecdsa`;
        const signatureResponse = await fetch(signatureUrl, {
          headers: {
            Authorization: `Bearer ${REDPILL_API_KEY}`,
          },
        });

        if (!signatureResponse.ok) {
          const errorText = await signatureResponse.text();
          logger.error(
            `Signature API failed with status ${signatureResponse.status}: ${errorText}`,
          );
          throw new Error(
            `Signature API failed: ${signatureResponse.status} ${signatureResponse.statusText}`,
          );
        }

        const signatureData: RedpillSignatureResponse =
          await signatureResponse.json();
        logger.info(
          `TEE signature retrieved successfully for request_id: ${requestId}`,
        );
        logger.debug("Signature response data:", { signatureData });

        // Return combined result with payment confirmation
        res.json({
          message: "Thanks for your payment! Here's your TEE-verified AI response.",
          chat: {
            request_id: chatData.id,
            model: chatData.model,
            response: chatData.choices[0]?.message.content || "",
            usage: chatData.usage,
          },
          tee_verification: {
            request_id: signatureData.request_id,
            signature: signatureData.signature,
            payload: signatureData.payload,
            cert_chain_length: signatureData.cert_chain?.length ?? 0,
          },
        });
      } catch (error) {
        logger.error("TEE demo endpoint failed:", error);
        res.status(500).json({
          error: "TEE verification failed",
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );

  const server = app.listen(port, () => {
    logger.info(`Resource server listening on port ${port}`);
  });

  function shutdown() {
    server.close(() => {
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

await run();
