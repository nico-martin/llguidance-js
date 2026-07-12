use llguidance::{api::TopLevelGrammar, Constraint, ParserFactory};
use serde::Deserialize;
use serde_json::{json, Value};
use toktrie::{ApproximateTokEnv, TokEnv, TokRxInfo, TokTrie};
use wasm_bindgen::prelude::*;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
#[no_mangle]
unsafe extern "Rust" fn __getrandom_v03_custom(
    dest: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    for idx in 0..len {
        *dest.add(idx) = (idx as u8).wrapping_mul(31).wrapping_add(17);
    }
    Ok(())
}

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
    response_format: Option<ResponseFormat>,
    grammar: Option<String>,
    #[serde(alias = "grammarFormat")]
    grammar_format: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ResponseFormat {
    #[serde(rename = "json_object")]
    JsonObject,
    #[serde(rename = "json_schema")]
    JsonSchema { json_schema: Value },
    #[serde(rename = "regex")]
    Regex { regex: String },
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

    #[wasm_bindgen(js_name = vocabSize)]
    pub fn vocab_size(&self) -> usize {
        self.tok_env.tok_trie().vocab_size()
    }

    #[wasm_bindgen(js_name = eosToken)]
    pub fn eos_token(&self) -> u32 {
        self.tok_env.eos_token()
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
        let grammar = grammar_from_interpreter_config(config)?;

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

#[wasm_bindgen(js_name = grammarFrom)]
pub fn grammar_from(format: &str, text: &str) -> Result<String, JsValue> {
    grammar_from_format(format, text).and_then(stringify_grammar)
}

#[wasm_bindgen(js_name = grammarFromJsonSchema)]
pub fn grammar_from_json_schema(schema: JsValue) -> Result<String, JsValue> {
    let schema: Value = serde_wasm_bindgen::from_value(schema)
        .map_err(|err| js_error(format!("invalid JSON schema: {err}")))?;
    stringify_grammar(TopLevelGrammar::from_json_schema(schema))
}

#[wasm_bindgen(js_name = grammarFromLark)]
pub fn grammar_from_lark(lark: &str) -> Result<String, JsValue> {
    stringify_grammar(TopLevelGrammar::from_lark(lark.to_string()))
}

#[wasm_bindgen(js_name = grammarFromRegex)]
pub fn grammar_from_regex(regex: &str) -> Result<String, JsValue> {
    stringify_grammar(TopLevelGrammar::from_regex(regex))
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

fn grammar_from_interpreter_config(config: InterpreterConfig) -> Result<TopLevelGrammar, JsValue> {
    if let Some(grammar) = config.grammar {
        return match config.grammar_format.as_deref() {
            Some(format) => grammar_from_format(format, &grammar),
            None => TopLevelGrammar::from_lark_or_grammar_list(&grammar)
                .map_err(|err| js_error(format!("invalid grammar: {err}"))),
        };
    }

    if let Some(format) = config.response_format {
        return Ok(grammar_from_response_format(format));
    }

    Err(js_error("interpreter config requires grammar or response_format"))
}

fn grammar_from_response_format(format: ResponseFormat) -> TopLevelGrammar {
    match format {
        ResponseFormat::JsonObject => TopLevelGrammar::from_json_schema(json!({ "type": "object" })),
        ResponseFormat::JsonSchema { json_schema } => TopLevelGrammar::from_json_schema(json_schema),
        ResponseFormat::Regex { regex } => TopLevelGrammar::from_regex(&regex),
    }
}

fn grammar_from_format(format: &str, text: &str) -> Result<TopLevelGrammar, JsValue> {
    match format {
        "lark" => Ok(TopLevelGrammar::from_lark(text.to_string())),
        "regex" => Ok(TopLevelGrammar::from_regex(text)),
        "json" | "json_schema" => serde_json::from_str(text)
            .map(TopLevelGrammar::from_json_schema)
            .map_err(|err| js_error(format!("invalid JSON schema: {err}"))),
        "json_object" => Ok(TopLevelGrammar::from_json_schema(json!({ "type": "object" }))),
        "choice" => {
            let choices: Vec<String> = serde_json::from_str(text)
                .map_err(|err| js_error(format!("invalid choice list: {err}")))?;
            let lark = format!(
                "start: {}",
                choices
                    .into_iter()
                    .map(|choice| serde_json::to_string(&choice).unwrap())
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
            Ok(TopLevelGrammar::from_lark(lark))
        }
        "llguidance" | "guidance" => TopLevelGrammar::from_lark_or_grammar_list(text)
            .map_err(|err| js_error(format!("invalid llguidance grammar: {err}"))),
        _ => Err(js_error(format!("unknown grammar format: {format}"))),
    }
}

fn stringify_grammar(grammar: TopLevelGrammar) -> Result<String, JsValue> {
    serde_json::to_string(&grammar).map_err(|err| js_error(format!("failed to serialize grammar: {err}")))
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
