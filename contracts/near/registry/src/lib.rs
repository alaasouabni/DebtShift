use near_sdk::{AccountId, PanicOnDefault, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgreementRegistry {
    owner_id: AccountId,
}
#[near]
impl AgreementRegistry {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_bytes32(value: &str) -> [u8; 32] {
        let hex = value
            .strip_prefix("0x")
            .expect("fixture hash has 0x prefix");
        assert_eq!(hex.len(), 64, "fixture hash is exactly 32 bytes");

        let mut decoded = [0_u8; 32];
        for (index, byte) in decoded.iter_mut().enumerate() {
            let offset = index * 2;
            *byte = u8::from_str_radix(&hex[offset..offset + 2], 16).expect("valid fixture hex");
        }
        decoded
    }

    #[test]
    fn exposes_the_configured_owner() {
        let owner_id: AccountId = "owner.testnet".parse().expect("valid test account");
        let registry = AgreementRegistry::new(owner_id.clone());

        assert_eq!(registry.owner_id(), owner_id);
    }

    #[test]
    fn matches_the_cross_language_migration_id_fixture() {
        let intent_hash =
            decode_bytes32("0x1512eaf38eaa112d95de0046d6c7471a9b3409f20a6afa6b20e3517a90ac3100");
        let quote_hash =
            decode_bytes32("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let expected =
            decode_bytes32("0x67c5975085073b2512ada4bfe6296d62b485f963078bb88c104d68958287d692");
        let mut abi_encoded = [0_u8; 96];
        abi_encoded[..32].copy_from_slice(&intent_hash);
        abi_encoded[32..64].copy_from_slice(&quote_hash);
        abi_encoded[95] = 9;

        assert_eq!(near_sdk::env::keccak256(abi_encoded), expected);
    }
}
