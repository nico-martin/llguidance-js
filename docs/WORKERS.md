# Worker Integration

The runtime has no DOM dependency and can own its tokenizer and interpreter in
a browser Web Worker. Keep model logits on the main thread and transfer only
the compact token mask and selected token IDs.

```js
// guidance-worker.js
import { loadJsonGuidance } from "llguidance/json-schema";

const runtime = await loadJsonGuidance();
let interpreter;

self.onmessage = ({ data }) => {
  switch (data.type) {
    case "initialize": {
      const tokenizer = runtime.createTokenizer(data.tokenizer);
      interpreter = runtime.createInterpreter({
        tokenizer,
        response_format: {
          type: "json_schema",
          json_schema: data.schema,
        },
        limits: data.limits,
      });
      self.postMessage({ type: "initialized" });
      break;
    }
    case "mask": {
      const result = interpreter.computeMask();
      if ("mask" in result) {
        self.postMessage(
          { type: "mask", mask: result.mask, vocabSize: result.vocabSize },
          [result.mask.buffer],
        );
      } else {
        self.postMessage({ type: "stop", reason: result.reason });
      }
      break;
    }
    case "commit":
      self.postMessage({
        type: "committed",
        result: interpreter.commitToken(data.token),
      });
      break;
    case "rollback":
      interpreter.rollback(data.count);
      self.postMessage({ type: "rolled-back" });
      break;
  }
};
```

Create the worker as an ES module:

```js
const worker = new Worker(new URL("./guidance-worker.js", import.meta.url), {
  type: "module",
});
```

Tokenizer byte arrays, schema objects, masks, and token IDs are structured
clone compatible. Interpreter instances are stateful and should remain inside
the worker that created them. A cloned interpreter can be used inside that
same worker for speculative branches.

Node.js `worker_threads` uses the same ownership pattern, replacing
`self.onmessage` and `self.postMessage` with `parentPort.on("message", ...)`
and `parentPort.postMessage(...)`.
