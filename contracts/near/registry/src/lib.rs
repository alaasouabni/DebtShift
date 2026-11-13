use near_sdk::borsh::BorshSerialize;
use near_sdk::serde_json::{Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, env, near, require,
};

const EVENT_STANDARD: &str = "debtshift";
const EVENT_VERSION: &str = "1.0.0";
const MAX_VERIFIERS: usize = 64;
const MAX_ATTESTATIONS: usize = 128;
const DEFAULT_PAGE_LIMIT: u32 = 25;
const MAX_PAGE_LIMIT: u32 = 50;
const MAX_ACTOR_ID_BYTES: usize = 160;
const MAX_CANONICAL_TEXT_BYTES: usize = 128;
const MAX_EVIDENCE_REFERENCE_BYTES: usize = 512;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Agreements,
    ReceiptAgreements,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActorIdentity {
    pub network: String,
    pub account: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RegisterAgreementRequest {
    pub agreement_id: String,
    pub intent_hash: String,
    pub execution_plan_hash: String,
    pub borrower: ActorIdentity,
    pub transport_provider: ActorIdentity,
    pub source_network: String,
    pub destination_network: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerificationState {
    Provisional,
    Confirmed,
    Finalized,
    Retracted,
    Rejected,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttestationInput {
    pub evidence_id: String,
    pub evidence_type: String,
    pub schema_version: u32,
    pub scheme: String,
    pub evidence_reference: String,
    pub verification_state: VerificationState,
    pub supersedes_evidence_id: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Attestation {
    pub sequence: u32,
    pub evidence_id: String,
    pub evidence_type: String,
    pub schema_version: u32,
    pub scheme: String,
    pub evidence_reference: String,
    pub verification_state: VerificationState,
    pub supersedes_evidence_id: Option<String>,
    pub verifier_id: AccountId,
    pub recorded_at_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalStatus {
    Completed,
    FailedSafe,
    RequoteRequired,
    Expired,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FinalReceipt {
    pub receipt_bundle_hash: String,
    pub terminal_status: TerminalStatus,
    pub finalized_by: AccountId,
    pub finalized_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Agreement {
    agreement_id: String,
    intent_hash: String,
    execution_plan_hash: String,
    borrower: ActorIdentity,
    transport_provider: ActorIdentity,
    source_network: String,
    destination_network: String,
    registered_by: AccountId,
    registered_at_ns: u64,
    attestations: Vec<Attestation>,
    final_receipt: Option<FinalReceipt>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgreementView {
    pub agreement_id: String,
    pub intent_hash: String,
    pub execution_plan_hash: String,
    pub borrower: ActorIdentity,
    pub transport_provider: ActorIdentity,
    pub source_network: String,
    pub destination_network: String,
    pub registered_by: AccountId,
    pub registered_at_ns: u64,
    pub attestation_count: u32,
    pub final_receipt: Option<FinalReceipt>,
}

impl From<&Agreement> for AgreementView {
    fn from(value: &Agreement) -> Self {
        Self {
            agreement_id: value.agreement_id.clone(),
            intent_hash: value.intent_hash.clone(),
            execution_plan_hash: value.execution_plan_hash.clone(),
            borrower: value.borrower.clone(),
            transport_provider: value.transport_provider.clone(),
            source_network: value.source_network.clone(),
            destination_network: value.destination_network.clone(),
            registered_by: value.registered_by.clone(),
            registered_at_ns: value.registered_at_ns,
            attestation_count: u32::try_from(value.attestations.len())
                .expect("bounded attestation count fits u32"),
            final_receipt: value.final_receipt.clone(),
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgreementRegistry {
    owner_id: AccountId,
    pending_owner_id: Option<AccountId>,
    verifiers: Vec<AccountId>,
    agreements: LookupMap<String, Agreement>,
    receipt_agreements: LookupMap<String, String>,
    agreement_count: u64,
}

#[near]
impl AgreementRegistry {
    #[init]
    pub fn new(owner_id: AccountId, initial_verifiers: Vec<AccountId>) -> Self {
        require!(
            !initial_verifiers.is_empty(),
            "At least one verifier is required"
        );
        require!(
            initial_verifiers.len() <= MAX_VERIFIERS,
            "Too many initial verifiers"
        );
        let mut verifiers = Vec::with_capacity(initial_verifiers.len());
        for verifier_id in initial_verifiers {
            require!(
                !verifiers.contains(&verifier_id),
                "Duplicate initial verifier"
            );
            verifiers.push(verifier_id);
        }

        emit_event(
            "registry_initialized",
            json!({ "owner_id": owner_id, "verifiers": verifiers }),
        );
        Self {
            owner_id,
            pending_owner_id: None,
            verifiers,
            agreements: LookupMap::new(StorageKey::Agreements),
            receipt_agreements: LookupMap::new(StorageKey::ReceiptAgreements),
            agreement_count: 0,
        }
    }

    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn pending_owner_id(&self) -> Option<AccountId> {
        self.pending_owner_id.clone()
    }

    pub fn agreement_count(&self) -> u64 {
        self.agreement_count
    }

    pub fn is_verifier(&self, account_id: AccountId) -> bool {
        self.verifiers.contains(&account_id)
    }

    pub fn list_verifiers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        paginated_slice(&self.verifiers, from_index, limit)
    }

    pub fn propose_owner(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        require!(
            new_owner_id != self.owner_id,
            "New owner must differ from owner"
        );
        self.pending_owner_id = Some(new_owner_id.clone());
        emit_event(
            "owner_transfer_proposed",
            json!({ "owner_id": self.owner_id, "pending_owner_id": new_owner_id }),
        );
    }

    pub fn cancel_owner_transfer(&mut self) {
        self.assert_owner();
        let pending_owner_id = self
            .pending_owner_id
            .take()
            .unwrap_or_else(|| env::panic_str("No owner transfer is pending"));
        emit_event(
            "owner_transfer_cancelled",
            json!({ "owner_id": self.owner_id, "pending_owner_id": pending_owner_id }),
        );
    }

    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(
            self.pending_owner_id.as_ref() == Some(&caller),
            "Only the pending owner can accept ownership"
        );
        let previous_owner_id = self.owner_id.clone();
        self.owner_id = caller.clone();
        self.pending_owner_id = None;
        emit_event(
            "owner_transferred",
            json!({ "previous_owner_id": previous_owner_id, "owner_id": caller }),
        );
    }

    pub fn add_verifier(&mut self, verifier_id: AccountId) {
        self.assert_owner();
        require!(
            self.verifiers.len() < MAX_VERIFIERS,
            "Verifier limit reached"
        );
        require!(
            !self.verifiers.contains(&verifier_id),
            "Verifier already configured"
        );
        self.verifiers.push(verifier_id.clone());
        emit_event(
            "verifier_added",
            json!({ "owner_id": self.owner_id, "verifier_id": verifier_id }),
        );
    }

    pub fn remove_verifier(&mut self, verifier_id: AccountId) {
        self.assert_owner();
        require!(self.verifiers.len() > 1, "Cannot remove the final verifier");
        let index = self
            .verifiers
            .iter()
            .position(|candidate| candidate == &verifier_id)
            .unwrap_or_else(|| env::panic_str("Verifier is not configured"));
        self.verifiers.swap_remove(index);
        emit_event(
            "verifier_removed",
            json!({ "owner_id": self.owner_id, "verifier_id": verifier_id }),
        );
    }

    #[payable]
    pub fn register_agreement(&mut self, request: RegisterAgreementRequest) -> AgreementView {
        let verifier_id = self.assert_verifier();
        validate_agreement_request(&request);
        require!(
            self.agreements.get(&request.agreement_id).is_none(),
            "Agreement already exists"
        );
        let initial_storage = env::storage_usage();
        let agreement = Agreement {
            agreement_id: request.agreement_id.clone(),
            intent_hash: request.intent_hash,
            execution_plan_hash: request.execution_plan_hash,
            borrower: request.borrower,
            transport_provider: request.transport_provider,
            source_network: request.source_network,
            destination_network: request.destination_network,
            registered_by: verifier_id.clone(),
            registered_at_ns: env::block_timestamp(),
            attestations: Vec::new(),
            final_receipt: None,
        };
        self.agreements
            .insert(agreement.agreement_id.clone(), agreement.clone());
        self.agreement_count = self
            .agreement_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Agreement count overflow"));
        self.agreements.flush();
        settle_storage(initial_storage);
        emit_event(
            "agreement_registered",
            json!({
                "agreement_id": agreement.agreement_id,
                "intent_hash": agreement.intent_hash,
                "execution_plan_hash": agreement.execution_plan_hash,
                "registered_by": verifier_id,
            }),
        );
        AgreementView::from(&agreement)
    }

    #[payable]
    pub fn append_attestation(
        &mut self,
        agreement_id: String,
        input: AttestationInput,
    ) -> Attestation {
        let verifier_id = self.assert_verifier();
        assert_hex32("agreement_id", &agreement_id);
        validate_attestation_input(&input);
        let initial_storage = env::storage_usage();
        let mut agreement = self
            .agreements
            .get(&agreement_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Agreement does not exist"));
        require!(
            agreement.final_receipt.is_none(),
            "Finalized agreements are immutable"
        );
        require!(
            agreement.attestations.len() < MAX_ATTESTATIONS,
            "Attestation limit reached"
        );
        require!(
            agreement
                .attestations
                .iter()
                .all(|existing| existing.evidence_id != input.evidence_id),
            "Evidence ID already attested"
        );
        validate_supersession(&agreement.attestations, &input);

        let attestation = Attestation {
            sequence: u32::try_from(agreement.attestations.len() + 1)
                .expect("bounded attestation count fits u32"),
            evidence_id: input.evidence_id,
            evidence_type: input.evidence_type,
            schema_version: input.schema_version,
            scheme: input.scheme,
            evidence_reference: input.evidence_reference,
            verification_state: input.verification_state,
            supersedes_evidence_id: input.supersedes_evidence_id,
            verifier_id: verifier_id.clone(),
            recorded_at_ns: env::block_timestamp(),
        };
        agreement.attestations.push(attestation.clone());
        self.agreements.insert(agreement_id.clone(), agreement);
        self.agreements.flush();
        settle_storage(initial_storage);
        emit_event(
            "attestation_appended",
            json!({
                "agreement_id": agreement_id,
                "sequence": attestation.sequence,
                "evidence_id": attestation.evidence_id,
                "verification_state": attestation.verification_state,
                "verifier_id": verifier_id,
            }),
        );
        attestation
    }

    #[payable]
    pub fn finalize_agreement(
        &mut self,
        agreement_id: String,
        receipt_bundle_hash: String,
        terminal_status: TerminalStatus,
    ) -> FinalReceipt {
        let verifier_id = self.assert_verifier();
        assert_hex32("agreement_id", &agreement_id);
        assert_hex32("receipt_bundle_hash", &receipt_bundle_hash);
        let initial_storage = env::storage_usage();
        let mut agreement = self
            .agreements
            .get(&agreement_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Agreement does not exist"));
        require!(
            agreement.final_receipt.is_none(),
            "Agreement already finalized"
        );
        require!(
            has_active_finalized_attestation(&agreement.attestations),
            "An active finalized attestation is required"
        );
        require!(
            self.receipt_agreements.get(&receipt_bundle_hash).is_none(),
            "Receipt bundle hash already registered"
        );

        let final_receipt = FinalReceipt {
            receipt_bundle_hash: receipt_bundle_hash.clone(),
            terminal_status,
            finalized_by: verifier_id.clone(),
            finalized_at_ns: env::block_timestamp(),
        };
        agreement.final_receipt = Some(final_receipt.clone());
        self.agreements.insert(agreement_id.clone(), agreement);
        self.receipt_agreements
            .insert(receipt_bundle_hash.clone(), agreement_id.clone());
        self.agreements.flush();
        self.receipt_agreements.flush();
        settle_storage(initial_storage);
        emit_event(
            "agreement_finalized",
            json!({
                "agreement_id": agreement_id,
                "receipt_bundle_hash": receipt_bundle_hash,
                "terminal_status": final_receipt.terminal_status,
                "finalized_by": verifier_id,
            }),
        );
        final_receipt
    }

    pub fn get_agreement(&self, agreement_id: String) -> Option<AgreementView> {
        assert_hex32("agreement_id", &agreement_id);
        self.agreements.get(&agreement_id).map(AgreementView::from)
    }

    pub fn get_attestations(
        &self,
        agreement_id: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Attestation> {
        assert_hex32("agreement_id", &agreement_id);
        self.agreements
            .get(&agreement_id)
            .map(|agreement| paginated_slice(&agreement.attestations, from_index, limit))
            .unwrap_or_default()
    }

    pub fn get_final_receipt(&self, agreement_id: String) -> Option<FinalReceipt> {
        assert_hex32("agreement_id", &agreement_id);
        self.agreements
            .get(&agreement_id)
            .and_then(|agreement| agreement.final_receipt.clone())
    }

    pub fn get_agreement_id_by_receipt_hash(&self, receipt_bundle_hash: String) -> Option<String> {
        assert_hex32("receipt_bundle_hash", &receipt_bundle_hash);
        self.receipt_agreements.get(&receipt_bundle_hash).cloned()
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner may call this method"
        );
    }

    fn assert_verifier(&self) -> AccountId {
        let verifier_id = env::predecessor_account_id();
        require!(
            self.verifiers.contains(&verifier_id),
            "Only a configured verifier may call this method"
        );
        verifier_id
    }
}

fn validate_agreement_request(request: &RegisterAgreementRequest) {
    assert_hex32("agreement_id", &request.agreement_id);
    assert_hex32("intent_hash", &request.intent_hash);
    assert_hex32("execution_plan_hash", &request.execution_plan_hash);
    validate_network_id("source_network", &request.source_network);
    validate_network_id("destination_network", &request.destination_network);
    require!(
        request.source_network != request.destination_network,
        "Source and destination networks must differ"
    );
    validate_actor("borrower", &request.borrower);
    validate_actor("transport_provider", &request.transport_provider);
    require!(
        request.borrower.network == request.source_network,
        "Borrower network must match source network"
    );
}

fn validate_attestation_input(input: &AttestationInput) {
    assert_hex32("evidence_id", &input.evidence_id);
    require!(input.schema_version > 0, "Schema version must be positive");
    validate_canonical_text(
        "evidence_type",
        &input.evidence_type,
        MAX_CANONICAL_TEXT_BYTES,
    );
    validate_canonical_text("scheme", &input.scheme, MAX_CANONICAL_TEXT_BYTES);
    validate_canonical_text(
        "evidence_reference",
        &input.evidence_reference,
        MAX_EVIDENCE_REFERENCE_BYTES,
    );
    if let Some(supersedes_evidence_id) = &input.supersedes_evidence_id {
        assert_hex32("supersedes_evidence_id", supersedes_evidence_id);
        require!(
            supersedes_evidence_id != &input.evidence_id,
            "Evidence cannot supersede itself"
        );
    }
}

fn validate_supersession(attestations: &[Attestation], input: &AttestationInput) {
    match (&input.verification_state, &input.supersedes_evidence_id) {
        (VerificationState::Retracted, Some(superseded_id)) => {
            require!(
                attestations
                    .iter()
                    .any(|attestation| &attestation.evidence_id == superseded_id),
                "Superseded evidence does not exist"
            );
            require!(
                attestations.iter().all(|attestation| {
                    attestation.supersedes_evidence_id.as_ref() != Some(superseded_id)
                }),
                "Evidence has already been superseded"
            );
        }
        (VerificationState::Retracted, None) => {
            env::panic_str("Retracted evidence must identify the superseded evidence")
        }
        (_, Some(_)) => env::panic_str("Only retracted evidence may supersede prior evidence"),
        (_, None) => {}
    }
}

fn has_active_finalized_attestation(attestations: &[Attestation]) -> bool {
    attestations.iter().any(|candidate| {
        candidate.verification_state == VerificationState::Finalized
            && attestations.iter().all(|later| {
                later.verification_state != VerificationState::Retracted
                    || later.supersedes_evidence_id.as_ref() != Some(&candidate.evidence_id)
            })
    })
}

fn validate_actor(label: &str, actor: &ActorIdentity) {
    validate_network_id(&format!("{label}.network"), &actor.network);
    validate_canonical_text(
        &format!("{label}.account"),
        &actor.account,
        MAX_ACTOR_ID_BYTES,
    );
}

fn validate_network_id(label: &str, value: &str) {
    validate_canonical_text(label, value, MAX_CANONICAL_TEXT_BYTES);
    let Some((namespace, reference)) = value.split_once(':') else {
        env::panic_str(&format!("{label} must use namespace:reference form"));
    };
    require!(
        !namespace.is_empty() && !reference.is_empty(),
        format!("{label} must include namespace and reference")
    );
    require!(
        namespace
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        format!("{label} namespace is invalid")
    );
    require!(
        reference
            .bytes()
            .all(|byte| { byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') }),
        format!("{label} reference is invalid")
    );
}

fn validate_canonical_text(label: &str, value: &str, max_bytes: usize) {
    require!(!value.is_empty(), format!("{label} cannot be empty"));
    require!(
        value.len() <= max_bytes,
        format!("{label} exceeds {max_bytes} bytes")
    );
    require!(
        value
            .bytes()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control()),
        format!("{label} contains unsupported characters")
    );
}

fn assert_hex32(label: &str, value: &str) {
    let bytes = value.as_bytes();
    require!(
        bytes.len() == 66 && bytes.starts_with(b"0x"),
        format!("{label} must be a 0x-prefixed 32-byte hash")
    );
    require!(
        bytes[2..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)),
        format!("{label} must use lowercase hexadecimal")
    );
}

fn paginated_slice<T: Clone>(values: &[T], from_index: Option<u32>, limit: Option<u32>) -> Vec<T> {
    let start = usize::try_from(from_index.unwrap_or(0)).expect("u32 fits usize");
    let requested_limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT);
    require!(requested_limit > 0, "Page limit must be positive");
    require!(
        requested_limit <= MAX_PAGE_LIMIT,
        "Page limit exceeds maximum"
    );
    if start >= values.len() {
        return Vec::new();
    }
    let end = start
        .saturating_add(usize::try_from(requested_limit).expect("u32 fits usize"))
        .min(values.len());
    values[start..end].to_vec()
}

fn settle_storage(initial_storage: u64) {
    let storage_used = env::storage_usage().saturating_sub(initial_storage);
    let required_yocto = env::storage_byte_cost()
        .as_yoctonear()
        .checked_mul(u128::from(storage_used))
        .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
    let attached_yocto = env::attached_deposit().as_yoctonear();
    require!(
        attached_yocto >= required_yocto,
        "Insufficient attached deposit for storage"
    );
    let refund_yocto = attached_yocto - required_yocto;
    if refund_yocto > 0 {
        Promise::new(env::predecessor_account_id())
            .transfer(NearToken::from_yoctonear(refund_yocto))
            .detach();
    }
}

fn emit_event(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_VERSION,
            "event": event,
            "data": [data],
        })
    ));
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::{NearToken, testing_env};

    use super::*;

    const AGREEMENT_ID: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const INTENT_HASH: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const PLAN_HASH: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
    const EVIDENCE_ONE: &str = "0x4444444444444444444444444444444444444444444444444444444444444444";
    const EVIDENCE_TWO: &str = "0x5555555555555555555555555555555555555555555555555555555555555555";
    const RECEIPT_HASH: &str = "0x6666666666666666666666666666666666666666666666666666666666666666";

    fn account(value: &str) -> AccountId {
        value.parse().expect("valid test account")
    }

    fn set_context(predecessor: &str, attached_near: u128, timestamp: u64) {
        let predecessor_id = account(predecessor);
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("registry.testnet"))
            .signer_account_id(predecessor_id.clone())
            .predecessor_account_id(predecessor_id)
            .account_balance(NearToken::from_near(100))
            .attached_deposit(NearToken::from_near(attached_near))
            .block_timestamp(timestamp);
        testing_env!(builder.build());
    }

    fn registry() -> AgreementRegistry {
        set_context("owner.testnet", 0, 1);
        AgreementRegistry::new(
            account("owner.testnet"),
            vec![account("verifier.testnet"), account("backup.testnet")],
        )
    }

    fn agreement_request() -> RegisterAgreementRequest {
        RegisterAgreementRequest {
            agreement_id: AGREEMENT_ID.to_owned(),
            intent_hash: INTENT_HASH.to_owned(),
            execution_plan_hash: PLAN_HASH.to_owned(),
            borrower: ActorIdentity {
                network: "eip155:8453".to_owned(),
                account: "0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa".to_owned(),
            },
            transport_provider: ActorIdentity {
                network: "near:mainnet".to_owned(),
                account: "1click.near".to_owned(),
            },
            source_network: "eip155:8453".to_owned(),
            destination_network: "eip155:42161".to_owned(),
        }
    }

    fn attestation(evidence_id: &str, verification_state: VerificationState) -> AttestationInput {
        AttestationInput {
            evidence_id: evidence_id.to_owned(),
            evidence_type: "SOURCE_CLOSE".to_owned(),
            schema_version: 1,
            scheme: "EVM_RECEIPT_CONFIRMATIONS".to_owned(),
            evidence_reference: "eip155:8453/tx/0xabc".to_owned(),
            verification_state,
            supersedes_evidence_id: None,
        }
    }

    fn register(registry: &mut AgreementRegistry) {
        set_context("verifier.testnet", 1, 10);
        registry.register_agreement(agreement_request());
    }

    fn assert_panics(action: impl FnOnce()) {
        assert!(
            catch_unwind(AssertUnwindSafe(action)).is_err(),
            "expected call to panic"
        );
    }

    #[test]
    fn initializes_roles_and_transfers_owner_in_two_steps() {
        let mut registry = registry();
        assert_eq!(registry.owner_id(), account("owner.testnet"));
        assert!(registry.is_verifier(account("verifier.testnet")));

        set_context("owner.testnet", 0, 2);
        registry.add_verifier(account("third.testnet"));
        registry.propose_owner(account("next-owner.testnet"));
        assert_eq!(
            registry.pending_owner_id(),
            Some(account("next-owner.testnet"))
        );

        set_context("attacker.testnet", 0, 3);
        assert_panics(|| registry.accept_owner());
        set_context("next-owner.testnet", 0, 4);
        registry.accept_owner();
        assert_eq!(registry.owner_id(), account("next-owner.testnet"));
        assert_eq!(registry.pending_owner_id(), None);
        assert!(
            get_logs()
                .iter()
                .any(|log| log.contains("owner_transferred"))
        );
    }

    #[test]
    fn registers_immutable_agreement_and_rejects_unauthorized_or_duplicate_writes() {
        let mut registry = registry();
        set_context("attacker.testnet", 1, 5);
        assert_panics(|| {
            registry.register_agreement(agreement_request());
        });

        register(&mut registry);
        let stored = registry
            .get_agreement(AGREEMENT_ID.to_owned())
            .expect("agreement stored");
        assert_eq!(stored.execution_plan_hash, PLAN_HASH);
        assert_eq!(stored.attestation_count, 0);
        assert_eq!(registry.agreement_count(), 1);

        set_context("verifier.testnet", 1, 11);
        assert_panics(|| {
            registry.register_agreement(agreement_request());
        });
    }

    #[test]
    fn rejects_state_growth_without_its_storage_deposit() {
        let mut registry = registry();
        set_context("verifier.testnet", 0, 12);
        assert_panics(|| {
            registry.register_agreement(agreement_request());
        });
    }

    #[test]
    fn appends_ordered_attestations_and_enforces_unique_retraction_supersession() {
        let mut registry = registry();
        register(&mut registry);

        set_context("verifier.testnet", 1, 20);
        let first = registry.append_attestation(
            AGREEMENT_ID.to_owned(),
            attestation(EVIDENCE_ONE, VerificationState::Finalized),
        );
        assert_eq!(first.sequence, 1);

        set_context("backup.testnet", 1, 21);
        let mut retraction = attestation(EVIDENCE_TWO, VerificationState::Retracted);
        retraction.supersedes_evidence_id = Some(EVIDENCE_ONE.to_owned());
        let second = registry.append_attestation(AGREEMENT_ID.to_owned(), retraction.clone());
        assert_eq!(second.sequence, 2);
        assert_eq!(second.verifier_id, account("backup.testnet"));

        let page = registry.get_attestations(AGREEMENT_ID.to_owned(), Some(1), Some(1));
        assert_eq!(page, vec![second]);

        set_context("backup.testnet", 1, 22);
        assert_panics(|| {
            registry.finalize_agreement(
                AGREEMENT_ID.to_owned(),
                RECEIPT_HASH.to_owned(),
                TerminalStatus::Completed,
            );
        });
        assert_panics(|| {
            registry.append_attestation(AGREEMENT_ID.to_owned(), retraction);
        });
    }

    #[test]
    fn finalizes_once_after_final_evidence_and_indexes_the_receipt_hash() {
        let mut registry = registry();
        register(&mut registry);
        set_context("verifier.testnet", 1, 30);
        registry.append_attestation(
            AGREEMENT_ID.to_owned(),
            attestation(EVIDENCE_ONE, VerificationState::Finalized),
        );

        set_context("backup.testnet", 1, 31);
        let receipt = registry.finalize_agreement(
            AGREEMENT_ID.to_owned(),
            RECEIPT_HASH.to_owned(),
            TerminalStatus::Completed,
        );
        assert_eq!(receipt.finalized_by, account("backup.testnet"));
        assert_eq!(
            registry.get_agreement_id_by_receipt_hash(RECEIPT_HASH.to_owned()),
            Some(AGREEMENT_ID.to_owned())
        );
        assert_eq!(
            registry.get_final_receipt(AGREEMENT_ID.to_owned()),
            Some(receipt)
        );

        set_context("verifier.testnet", 1, 32);
        assert_panics(|| {
            registry.finalize_agreement(
                AGREEMENT_ID.to_owned(),
                RECEIPT_HASH.to_owned(),
                TerminalStatus::Completed,
            );
        });
        assert_panics(|| {
            registry.append_attestation(
                AGREEMENT_ID.to_owned(),
                attestation(EVIDENCE_TWO, VerificationState::Finalized),
            );
        });
    }

    #[test]
    fn requires_finalized_evidence_before_terminal_receipt() {
        let mut registry = registry();
        register(&mut registry);
        set_context("verifier.testnet", 1, 40);
        registry.append_attestation(
            AGREEMENT_ID.to_owned(),
            attestation(EVIDENCE_ONE, VerificationState::Confirmed),
        );
        set_context("verifier.testnet", 1, 41);
        assert_panics(|| {
            registry.finalize_agreement(
                AGREEMENT_ID.to_owned(),
                RECEIPT_HASH.to_owned(),
                TerminalStatus::Completed,
            );
        });
    }

    #[test]
    fn validates_hashes_networks_and_bounded_pages() {
        let mut registry = registry();
        set_context("verifier.testnet", 1, 50);
        let mut malformed = agreement_request();
        malformed.intent_hash = "0xABCD".to_owned();
        assert_panics(|| {
            registry.register_agreement(malformed);
        });
        assert_panics(|| {
            registry.list_verifiers(Some(0), Some(MAX_PAGE_LIMIT + 1));
        });
    }

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
