use candle::{DType, Device, Module, Result, Tensor, D};
use candle_nn::{linear_b as linear, Activation, Linear, VarBuilder};
use serde::Deserialize;
use std::{fs, path::Path, sync::Arc};
use tokenizers::Tokenizer;

#[derive(Deserialize, Debug, Clone)]
struct Config {
    attention_bias: bool,
    head_dim: usize,
    hidden_activation: Activation,
    hidden_size: usize,
    intermediate_size: usize,
    #[serde(default)]
    layer_types: Vec<String>,
    max_position_embeddings: usize,
    num_attention_heads: usize,
    num_hidden_layers: usize,
    num_key_value_heads: usize,
    pad_token_id: u32,
    rms_norm_eps: f64,
    rope_local_base_freq: f64,
    rope_theta: f64,
    sliding_window: usize,
    #[serde(
        alias = "_sliding_window_pattern",
        default = "default_sliding_window_pattern"
    )]
    sliding_window_pattern: usize,
    vocab_size: usize,
}

#[derive(Deserialize)]
struct DenseConfig {
    in_features: usize,
    out_features: usize,
    bias: bool,
}

pub struct EmbeddingGemma {
    tokenizer: Tokenizer,
    transformer: Gemma3TextEncoder,
    dense_2: DenseLayer,
    dense_3: DenseLayer,
    device: Device,
}

impl EmbeddingGemma {
    pub fn load(path: &Path) -> Result<Self> {
        let device = candle_device();
        let dtype = candle_dtype(&device);
        let config = read_json::<Config>(&path.join("config.json"))?;
        let tokenizer = Tokenizer::from_file(path.join("tokenizer.json"))
            .map_err(|error| candle::Error::Msg(error.to_string()))?;
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[path.join("model.safetensors")], dtype, &device)?
        };
        let transformer = Gemma3TextEncoder::new(&config, vb)?;
        let dense_2 = DenseLayer::load(&path.join("2_Dense"), dtype, &device)?;
        let dense_3 = DenseLayer::load(&path.join("3_Dense"), dtype, &device)?;
        Ok(Self {
            tokenizer,
            transformer,
            dense_2,
            dense_3,
            device,
        })
    }

    pub fn embed_batch(&mut self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }

        let mut encoded = Vec::with_capacity(inputs.len());
        let mut max_len = 0usize;
        for input in inputs {
            let encoding = self
                .tokenizer
                .encode(input.as_str(), true)
                .map_err(|error| candle::Error::Msg(error.to_string()))?;
            let ids = encoding.get_ids();
            if ids.is_empty() {
                candle::bail!("EmbeddingGemma input produced no tokens");
            }
            max_len = max_len.max(ids.len());
            encoded.push((ids.to_vec(), encoding.get_attention_mask().to_vec()));
        }

        let batch_size = encoded.len();
        let mut token_ids = Vec::with_capacity(batch_size * max_len);
        let mut attention_masks = Vec::with_capacity(batch_size);
        for (mut ids, mut mask) in encoded {
            ids.resize(max_len, self.transformer.pad_token_id);
            mask.resize(max_len, 0);
            token_ids.extend(ids);
            attention_masks.push(mask);
        }

        let token_ids = Tensor::from_vec(token_ids, (batch_size, max_len), &self.device)?;
        let hidden_states = self.transformer.forward(&token_ids, &attention_masks)?;
        let pooled = mean_pool(&hidden_states, &attention_masks, &self.device)?;
        let projected = self.dense_2.forward(&pooled)?;
        let projected = self.dense_3.forward(&projected)?;
        let normalized = l2_normalize(&projected)?;
        normalized.to_dtype(DType::F32)?.to_vec2::<f32>()
    }
}

struct DenseLayer {
    linear: Linear,
}

impl DenseLayer {
    fn load(path: &Path, dtype: DType, device: &Device) -> Result<Self> {
        let config = read_json::<DenseConfig>(&path.join("config.json"))?;
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[path.join("model.safetensors")], dtype, device)?
        };
        let linear = linear(
            config.in_features,
            config.out_features,
            config.bias,
            vb.pp("linear"),
        )?;
        Ok(Self { linear })
    }
}

impl Module for DenseLayer {
    fn forward(&self, xs: &Tensor) -> Result<Tensor> {
        self.linear.forward(xs)
    }
}

#[derive(Debug, Clone)]
struct RmsNorm {
    weight: Tensor,
    eps: f64,
}

impl RmsNorm {
    fn new(dim: usize, eps: f64, vb: VarBuilder) -> Result<Self> {
        let weight = vb.get(dim, "weight")?;
        Ok(Self { weight, eps })
    }
}

impl Module for RmsNorm {
    fn forward(&self, x: &Tensor) -> Result<Tensor> {
        let x_dtype = x.dtype();
        let internal_dtype = match x_dtype {
            DType::F16 | DType::BF16 => DType::F32,
            dtype => dtype,
        };
        let hidden_size = x.dim(D::Minus1)?;
        let x = x.to_dtype(internal_dtype)?;
        let norm_x = (x.sqr()?.sum_keepdim(D::Minus1)? / hidden_size as f64)?;
        let x_normed = x.broadcast_div(&(norm_x + self.eps)?.sqrt()?)?;
        x_normed
            .to_dtype(x_dtype)?
            .broadcast_mul(&(&self.weight + 1.0)?)
    }
}

#[derive(Debug, Clone)]
struct RotaryEmbedding {
    sin: Tensor,
    cos: Tensor,
}

impl RotaryEmbedding {
    fn new(dtype: DType, cfg: &Config, device: &Device, sliding_window: bool) -> Result<Self> {
        let rope_freq = if sliding_window {
            cfg.rope_local_base_freq
        } else {
            cfg.rope_theta
        };
        let inv_freq = (0..cfg.head_dim)
            .step_by(2)
            .map(|i| 1f32 / rope_freq.powf(i as f64 / cfg.head_dim as f64) as f32)
            .collect::<Vec<_>>();
        let inv_freq_len = inv_freq.len();
        let inv_freq = Tensor::from_vec(inv_freq, (1, inv_freq_len), device)?.to_dtype(dtype)?;
        let t = Tensor::arange(0u32, cfg.max_position_embeddings as u32, device)?
            .to_dtype(dtype)?
            .reshape((cfg.max_position_embeddings, 1))?;
        let freqs = t.matmul(&inv_freq)?;
        Ok(Self {
            sin: freqs.sin()?,
            cos: freqs.cos()?,
        })
    }

    fn apply_rotary_emb_qkv(&self, q: &Tensor, k: &Tensor) -> Result<(Tensor, Tensor)> {
        let (_batch, _heads, seq_len, _dim) = q.dims4()?;
        let cos = self.cos.narrow(0, 0, seq_len)?;
        let sin = self.sin.narrow(0, 0, seq_len)?;
        let q_embed = candle_nn::rotary_emb::rope(&q.contiguous()?, &cos, &sin)?;
        let k_embed = candle_nn::rotary_emb::rope(&k.contiguous()?, &cos, &sin)?;
        Ok((q_embed, k_embed))
    }
}

#[derive(Debug, Clone)]
struct Mlp {
    gate_proj: Linear,
    up_proj: Linear,
    down_proj: Linear,
    act_fn: Activation,
}

impl Mlp {
    fn new(cfg: &Config, vb: VarBuilder) -> Result<Self> {
        let gate_proj = linear(
            cfg.hidden_size,
            cfg.intermediate_size,
            false,
            vb.pp("gate_proj"),
        )?;
        let up_proj = linear(
            cfg.hidden_size,
            cfg.intermediate_size,
            false,
            vb.pp("up_proj"),
        )?;
        let down_proj = linear(
            cfg.intermediate_size,
            cfg.hidden_size,
            false,
            vb.pp("down_proj"),
        )?;
        Ok(Self {
            gate_proj,
            up_proj,
            down_proj,
            act_fn: cfg.hidden_activation,
        })
    }
}

impl Module for Mlp {
    fn forward(&self, xs: &Tensor) -> Result<Tensor> {
        let lhs = xs.apply(&self.gate_proj)?.apply(&self.act_fn)?;
        let rhs = xs.apply(&self.up_proj)?;
        (lhs * rhs)?.apply(&self.down_proj)
    }
}

#[derive(Debug, Clone)]
struct Attention {
    q_proj: Linear,
    k_proj: Linear,
    v_proj: Linear,
    o_proj: Linear,
    q_norm: RmsNorm,
    k_norm: RmsNorm,
    num_heads: usize,
    num_kv_heads: usize,
    num_kv_groups: usize,
    head_dim: usize,
    rotary_emb: Arc<RotaryEmbedding>,
}

impl Attention {
    fn new(rotary_emb: Arc<RotaryEmbedding>, cfg: &Config, vb: VarBuilder) -> Result<Self> {
        let q_proj = linear(
            cfg.hidden_size,
            cfg.num_attention_heads * cfg.head_dim,
            cfg.attention_bias,
            vb.pp("q_proj"),
        )?;
        let k_proj = linear(
            cfg.hidden_size,
            cfg.num_key_value_heads * cfg.head_dim,
            cfg.attention_bias,
            vb.pp("k_proj"),
        )?;
        let v_proj = linear(
            cfg.hidden_size,
            cfg.num_key_value_heads * cfg.head_dim,
            cfg.attention_bias,
            vb.pp("v_proj"),
        )?;
        let o_proj = linear(
            cfg.num_attention_heads * cfg.head_dim,
            cfg.hidden_size,
            cfg.attention_bias,
            vb.pp("o_proj"),
        )?;
        let q_norm = RmsNorm::new(cfg.head_dim, cfg.rms_norm_eps, vb.pp("q_norm"))?;
        let k_norm = RmsNorm::new(cfg.head_dim, cfg.rms_norm_eps, vb.pp("k_norm"))?;
        Ok(Self {
            q_proj,
            k_proj,
            v_proj,
            o_proj,
            q_norm,
            k_norm,
            num_heads: cfg.num_attention_heads,
            num_kv_heads: cfg.num_key_value_heads,
            num_kv_groups: cfg.num_attention_heads / cfg.num_key_value_heads,
            head_dim: cfg.head_dim,
            rotary_emb,
        })
    }

    fn forward(&self, xs: &Tensor, attention_mask: Option<&Tensor>) -> Result<Tensor> {
        let (batch_size, seq_len, _) = xs.dims3()?;
        let query_states = self.q_proj.forward(xs)?;
        let key_states = self.k_proj.forward(xs)?;
        let value_states = self.v_proj.forward(xs)?;
        let query_states = query_states
            .reshape((batch_size, seq_len, self.num_heads, self.head_dim))?
            .transpose(1, 2)?;
        let key_states = key_states
            .reshape((batch_size, seq_len, self.num_kv_heads, self.head_dim))?
            .transpose(1, 2)?;
        let value_states = value_states
            .reshape((batch_size, seq_len, self.num_kv_heads, self.head_dim))?
            .transpose(1, 2)?;
        let query_states = self.q_norm.forward(&query_states)?;
        let key_states = self.k_norm.forward(&key_states)?;
        let (query_states, key_states) = self
            .rotary_emb
            .apply_rotary_emb_qkv(&query_states, &key_states)?;
        let key_states =
            candle_transformers::utils::repeat_kv(key_states, self.num_kv_groups)?.contiguous()?;
        let value_states = candle_transformers::utils::repeat_kv(value_states, self.num_kv_groups)?
            .contiguous()?;
        let scale = 1f64 / f64::sqrt(self.head_dim as f64);
        let attn_weights = (query_states.matmul(&key_states.transpose(2, 3)?)? * scale)?;
        let attn_weights = match attention_mask {
            Some(mask) => attn_weights.broadcast_add(mask)?,
            None => attn_weights,
        };
        let attn_weights = candle_nn::ops::softmax_last_dim(&attn_weights)?;
        let attn_output = attn_weights.matmul(&value_states)?;
        attn_output
            .transpose(1, 2)?
            .reshape((batch_size, seq_len, ()))?
            .apply(&self.o_proj)
    }
}

#[derive(Debug, Clone)]
struct DecoderLayer {
    self_attn: Attention,
    mlp: Mlp,
    input_layernorm: RmsNorm,
    pre_feedforward_layernorm: RmsNorm,
    post_feedforward_layernorm: RmsNorm,
    post_attention_layernorm: RmsNorm,
    sliding_window: bool,
}

impl DecoderLayer {
    fn new(cfg: &Config, vb: VarBuilder, sliding_window: bool) -> Result<Self> {
        let rotary_emb = Arc::new(RotaryEmbedding::new(
            vb.dtype(),
            cfg,
            vb.device(),
            sliding_window,
        )?);
        let self_attn = Attention::new(rotary_emb, cfg, vb.pp("self_attn"))?;
        let mlp = Mlp::new(cfg, vb.pp("mlp"))?;
        let input_layernorm =
            RmsNorm::new(cfg.hidden_size, cfg.rms_norm_eps, vb.pp("input_layernorm"))?;
        let pre_feedforward_layernorm = RmsNorm::new(
            cfg.hidden_size,
            cfg.rms_norm_eps,
            vb.pp("pre_feedforward_layernorm"),
        )?;
        let post_feedforward_layernorm = RmsNorm::new(
            cfg.hidden_size,
            cfg.rms_norm_eps,
            vb.pp("post_feedforward_layernorm"),
        )?;
        let post_attention_layernorm = RmsNorm::new(
            cfg.hidden_size,
            cfg.rms_norm_eps,
            vb.pp("post_attention_layernorm"),
        )?;
        Ok(Self {
            self_attn,
            mlp,
            input_layernorm,
            pre_feedforward_layernorm,
            post_feedforward_layernorm,
            post_attention_layernorm,
            sliding_window,
        })
    }

    fn forward(&self, xs: &Tensor, attention_mask: Option<&Tensor>) -> Result<Tensor> {
        let residual = xs;
        let xs = self.input_layernorm.forward(xs)?;
        let xs = self.self_attn.forward(&xs, attention_mask)?;
        let xs = xs.apply(&self.post_attention_layernorm)?;
        let xs = (xs + residual)?;
        let residual = &xs;
        let xs = xs.apply(&self.pre_feedforward_layernorm)?;
        let xs = xs.apply(&self.mlp)?;
        let xs = xs.apply(&self.post_feedforward_layernorm)?;
        residual + xs
    }
}

struct Gemma3TextEncoder {
    embed_tokens: candle_nn::Embedding,
    layers: Vec<DecoderLayer>,
    norm: RmsNorm,
    device: Device,
    dtype: DType,
    hidden_size: usize,
    pad_token_id: u32,
    sliding_window: usize,
}

impl Gemma3TextEncoder {
    fn new(cfg: &Config, vb: VarBuilder) -> Result<Self> {
        let embed_tokens =
            candle_nn::embedding(cfg.vocab_size, cfg.hidden_size, vb.pp("embed_tokens"))?;
        let mut layers = Vec::with_capacity(cfg.num_hidden_layers);
        let vb_l = vb.pp("layers");
        for layer_idx in 0..cfg.num_hidden_layers {
            let sliding_window = cfg
                .layer_types
                .get(layer_idx)
                .map(|kind| kind == "sliding_attention")
                .unwrap_or_else(|| (layer_idx + 1) % cfg.sliding_window_pattern > 0);
            layers.push(DecoderLayer::new(cfg, vb_l.pp(layer_idx), sliding_window)?);
        }
        let norm = RmsNorm::new(cfg.hidden_size, cfg.rms_norm_eps, vb.pp("norm"))?;
        Ok(Self {
            embed_tokens,
            layers,
            norm,
            device: vb.device().clone(),
            dtype: vb.dtype(),
            hidden_size: cfg.hidden_size,
            pad_token_id: cfg.pad_token_id,
            sliding_window: cfg.sliding_window,
        })
    }

    fn forward(&self, input_ids: &Tensor, attention_masks: &[Vec<u32>]) -> Result<Tensor> {
        let (batch_size, seq_len) = input_ids.dims2()?;
        let xs = self.embed_tokens.forward(input_ids)?;
        let mut xs = (xs * (self.hidden_size as f64).sqrt())?;
        let padding_mask = prepare_padding_attention_mask(
            attention_masks,
            batch_size,
            seq_len,
            self.dtype,
            &self.device,
        )?;
        let sliding_attention_mask = prepare_bidirectional_sliding_mask(
            batch_size,
            seq_len,
            self.sliding_window,
            self.dtype,
            &self.device,
        )?;
        for layer in &self.layers {
            let mask = if layer.sliding_window {
                sliding_attention_mask.broadcast_add(&padding_mask)?
            } else {
                padding_mask.clone()
            };
            let mask = Some(&mask);
            xs = layer.forward(&xs, mask)?;
        }
        xs.apply(&self.norm)
    }
}

fn prepare_bidirectional_sliding_mask(
    batch_size: usize,
    seq_len: usize,
    sliding_window: usize,
    dtype: DType,
    device: &Device,
) -> Result<Tensor> {
    let half_window = sliding_window / 2;
    let mask = (0..seq_len)
        .flat_map(|i| {
            (0..seq_len).map(move |j| {
                if i.abs_diff(j) > half_window {
                    f32::NEG_INFINITY
                } else {
                    0.0
                }
            })
        })
        .collect::<Vec<_>>();
    Tensor::from_slice(&mask, (seq_len, seq_len), device)?
        .expand((batch_size, 1, seq_len, seq_len))?
        .to_dtype(dtype)
}

fn prepare_padding_attention_mask(
    attention_masks: &[Vec<u32>],
    batch_size: usize,
    seq_len: usize,
    dtype: DType,
    device: &Device,
) -> Result<Tensor> {
    let mask = attention_masks
        .iter()
        .flat_map(|row| {
            row.iter()
                .take(seq_len)
                .map(|value| if *value == 0 { f32::NEG_INFINITY } else { 0.0 })
        })
        .collect::<Vec<_>>();
    Tensor::from_vec(mask, (batch_size, 1, 1, seq_len), device)?.to_dtype(dtype)
}

fn mean_pool(
    hidden_states: &Tensor,
    attention_masks: &[Vec<u32>],
    device: &Device,
) -> Result<Tensor> {
    let (batch_size, seq_len, _hidden_size) = hidden_states.dims3()?;
    let mask = attention_masks
        .iter()
        .flat_map(|row| {
            row.iter()
                .take(seq_len)
                .map(|value| if *value == 0 { 0f32 } else { 1f32 })
        })
        .collect::<Vec<_>>();
    let counts = attention_masks
        .iter()
        .map(|row| {
            row.iter()
                .take(seq_len)
                .filter(|value| **value != 0)
                .count()
                .max(1) as f32
        })
        .collect::<Vec<_>>();
    let mask = Tensor::from_vec(mask, (batch_size, seq_len, 1), device)?
        .to_dtype(hidden_states.dtype())?;
    let counts =
        Tensor::from_vec(counts, (batch_size, 1), device)?.to_dtype(hidden_states.dtype())?;
    let summed = hidden_states.broadcast_mul(&mask)?.sum(1)?;
    summed.broadcast_div(&counts)
}

fn l2_normalize(xs: &Tensor) -> Result<Tensor> {
    let norm = xs.sqr()?.sum_keepdim(D::Minus1)?.sqrt()?;
    xs.broadcast_div(&norm)
}

fn candle_device() -> Device {
    Device::Cpu
}

fn candle_dtype(_device: &Device) -> DType {
    DType::F32
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let raw = fs::read_to_string(path).map_err(|error| {
        candle::Error::Msg(format!("Unable to read {}: {error}", path.display()))
    })?;
    serde_json::from_str(&raw)
        .map_err(|error| candle::Error::Msg(format!("Unable to parse {}: {error}", path.display())))
}

fn default_sliding_window_pattern() -> usize {
    6
}
