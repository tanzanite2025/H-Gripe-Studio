use sha2::{Digest, Sha256};

/// Hashes canonical unpacked sensor samples as consecutive little-endian u16.
pub fn canonical_sensor_digest_u16_le(samples: &[u16]) -> String {
    let mut hasher = Sha256::new();
    for sample in samples {
        hasher.update(sample.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::canonical_sensor_digest_u16_le;

    #[test]
    fn canonical_digest_has_stable_little_endian_bytes() {
        assert_eq!(
            canonical_sensor_digest_u16_le(&[0x0000, 0x1234, 0xabcd, 0xffff]),
            "de1dcce9af6cfb93f73448abd357682ebc72e76d60de094966a70a617659827a"
        );
    }
}
