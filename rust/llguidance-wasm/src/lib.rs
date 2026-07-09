use llguidance::{api::TopLevelGrammar, Constraint, ParserFactory};
use serde::Deserialize;
use serde_json::{json, Value};
use toktrie::{ApproximateTokEnv, TokEnv, TokRxInfo, TokTrie};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenizerConfig {
    tokens: Option<Vec<Vec<u8>>>,
    eos_token_id: Option<u32>,
    bos_token_id: Option<u32>,
    special_token_ids: Option<Vec<u32>>,
}

#[derive(Deserialize)]
struct InterpreterConfig {
    response_format: ResponseFormat,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ResponseFormat {
    #[serde(rename = "json_object")]
    JsonObject,
    #[serde(rename = "json_schema")]
    JsonSchema { json_schema: Value },
}

#[wasm_bindgen]
pub struct LLGuidanceTokenizer {
    tok_env: TokEnv,
}

#[wasm_bindgen]
impl LLGuidanceTokenizer {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<LLGuidanceTokenizer, JsValue> {
        let config: TokenizerConfig = serde_wasm_bindgen::from_value(config)
            .map_err(|err| js_error(format!("invalid tokenizer config: {err}")))?;

        let tok_env = match config.tokens {
            Some(tokens) => build_token_env(
                tokens,
                config.eos_token_id,
                config.bos_token_id,
                config.special_token_ids,
            )?,
            None => ApproximateTokEnv::single_byte_env(),
        };

        Ok(Self { tok_env })
    }
}

#[wasm_bindgen]
pub struct LLGuidanceInterpreter {
    constraint: Constraint,
}

#[wasm_bindgen]
impl LLGuidanceInterpreter {
    #[wasm_bindgen(constructor)]
    pub fn new(
        tokenizer: &LLGuidanceTokenizer,
        config: JsValue,
    ) -> Result<LLGuidanceInterpreter, JsValue> {
        let config: InterpreterConfig = serde_wasm_bindgen::from_value(config)
            .map_err(|err| js_error(format!("invalid interpreter config: {err}")))?;
        let grammar = grammar_from_response_format(config.response_format);

        let mut factory = ParserFactory::new_simple(&tokenizer.tok_env)
            .map_err(|err| js_error(format!("failed to create parser factory: {err}")))?;
        factory.set_stderr_log_level(0);

        let parser = factory
            .create_parser(grammar)
            .map_err(|err| js_error(format!("failed to create parser: {err}")))?;

        Ok(Self {
            constraint: Constraint::new(parser),
        })
    }

    #[wasm_bindgen(js_name = computeMask)]
    pub fn compute_mask(&mut self) -> Result<JsValue, JsValue> {
        let step = self
            .constraint
            .compute_mask()
            .map_err(|err| js_error(format!("computeMask failed: {err}")))?;

        if step.is_stop() {
            return serde_wasm_bindgen::to_value(&json!({ "stop": true }))
                .map_err(|err| js_error(format!("failed to serialize stop result: {err}")));
        }

        if let Some(splice) = step.unconditional_splice() {
            return serde_wasm_bindgen::to_value(&json!({
                "backtrack": splice.backtrack,
                "ffTokens": splice.ff_tokens,
            }))
            .map_err(|err| js_error(format!("failed to serialize splice result: {err}")));
        }

        let mask = step
            .sample_mask
            .as_ref()
            .ok_or_else(|| js_error("computeMask returned no sample mask"))?;
        let out = js_sys::Uint32Array::from(mask.as_slice());
        let result = JsValue::from(js_sys::Object::new());
        js_sys::Reflect::set(&result, &JsValue::from_str("mask"), out.as_ref())?;
        js_sys::Reflect::set(
            &result,
            &JsValue::from_str("vocabSize"),
            &JsValue::from_f64(mask.len() as f64),
        )?;
        Ok(result)
    }

    #[wasm_bindgen(js_name = commitToken)]
    pub fn commit_token(&mut self, token_id: u32) -> Result<JsValue, JsValue> {
        let result = self
            .constraint
            .commit_token(Some(token_id))
            .map_err(|err| js_error(format!("commitToken failed: {err}")))?;

        serde_wasm_bindgen::to_value(&json!({
            "stop": result.stop,
            "backtrack": result.backtrack,
            "ffTokens": result.ff_tokens,
        }))
        .map_err(|err| js_error(format!("failed to serialize commit result: {err}")))
    }
}

fn build_token_env(
    tokens: Vec<Vec<u8>>,
    eos_token_id: Option<u32>,
    bos_token_id: Option<u32>,
    special_token_ids: Option<Vec<u32>>,
) -> Result<TokEnv, JsValue> {
    if tokens.is_empty() {
        return Err(js_error("tokens must not be empty"));
    }

    let vocab_size = tokens.len() as u32;
    let tok_eos = eos_token_id.unwrap_or(vocab_size - 1);
    if tok_eos >= vocab_size {
        return Err(js_error("eos_token_id is outside the vocabulary"));
    }
    if let Some(tok_bos) = bos_token_id {
        if tok_bos >= vocab_size {
            return Err(js_error("bos_token_id is outside the vocabulary"));
        }
    }
    if let Some(special_token_ids) = special_token_ids {
        for token_id in special_token_ids {
            if token_id >= vocab_size {
                return Err(js_error("special_token_ids contains an id outside the vocabulary"));
            }
        }
    }

    let mut info = TokRxInfo::new(vocab_size, tok_eos);
    info.tok_bos = bos_token_id;
    Ok(ApproximateTokEnv::new(TokTrie::from(&info, &tokens)).into_env())
}

fn grammar_from_response_format(format: ResponseFormat) -> TopLevelGrammar {
    match format {
        ResponseFormat::JsonObject => TopLevelGrammar::from_json_schema(json!({ "type": "object" })),
        ResponseFormat::JsonSchema { json_schema } => TopLevelGrammar::from_json_schema(json_schema),
    }
}

fn js_error(message: impl Into<String>) -> JsValue {
    js_sys::Error::new(&message.into()).into()
}

trait IntoTokEnv {
    fn into_env(self) -> TokEnv;
}

impl IntoTokEnv for ApproximateTokEnv {
    fn into_env(self) -> TokEnv {
        std::sync::Arc::new(self)
    }
}
