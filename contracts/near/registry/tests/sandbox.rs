#![cfg(feature = "sandbox-tests")]

use std::path::PathBuf;

use anyhow::{Context, Result};
use near_workspaces::{Account, Contract, Worker, network::Sandbox, types::NearToken};
use serde_json::{Value, json};

const AGREEMENT_ID: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const INTENT_HASH: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const PLAN_HASH: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
const EVIDENCE_ID: &str = "0x4444444444444444444444444444444444444444444444444444444444444444";
const RECEIPT_HASH: &str = "0x6666666666666666666666666666666666666666666666666666666666666666";

fn registry_wasm_path() -> PathBuf {
    std::env::var_os("DEBTSHIFT_REGISTRY_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../target/near/debtshift_registry/debtshift_registry.wasm")
        })
}

async fn initialize_registry(
    worker: &Worker<Sandbox>,
) -> Result<(Contract, Account, Account, Account)> {
    let wasm_path = registry_wasm_path();
    let wasm = std::fs::read(&wasm_path)
        .with_context(|| format!("read registry WASM at {}", wasm_path.display()))?;
    let contract = worker.dev_deploy(&wasm).await?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    let attacker = worker.dev_create_account().await?;

    contract
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "initial_verifiers": [verifier.id()],
        }))
        .transact()
        .await?
        .into_result()?;

    Ok((contract, owner, verifier, attacker))
}

fn agreement_request() -> Value {
    json!({
        "agreement_id": AGREEMENT_ID,
        "intent_hash": INTENT_HASH,
        "execution_plan_hash": PLAN_HASH,
        "borrower": {
            "network": "eip155:8453",
            "account": "0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa",
        },
        "transport_provider": {
            "network": "near:mainnet",
            "account": "1click.near",
        },
        "source_network": "eip155:8453",
        "destination_network": "eip155:42161",
    })
}

async fn register_agreement(caller: &Account, contract: &Contract) -> Result<()> {
    caller
        .call(contract.id(), "register_agreement")
        .args_json(json!({ "request": agreement_request() }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn enforces_roles_and_persists_an_immutable_terminal_receipt() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let (contract, owner, verifier, attacker) = initialize_registry(&worker).await?;

    let configured_owner: String = contract.call("owner_id").view().await?.json()?;
    assert_eq!(configured_owner, owner.id().as_str());

    let unauthorized_registration = attacker
        .call(contract.id(), "register_agreement")
        .args_json(json!({ "request": agreement_request() }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(unauthorized_registration.is_failure());

    register_agreement(&verifier, &contract).await?;
    let agreement: Value = contract
        .call("get_agreement")
        .args_json(json!({ "agreement_id": AGREEMENT_ID }))
        .view()
        .await?
        .json()?;
    assert_eq!(agreement["agreement_id"], AGREEMENT_ID);
    assert_eq!(agreement["intent_hash"], INTENT_HASH);
    assert_eq!(agreement["execution_plan_hash"], PLAN_HASH);
    assert_eq!(agreement["attestation_count"], 0);

    verifier
        .call(contract.id(), "append_attestation")
        .args_json(json!({
            "agreement_id": AGREEMENT_ID,
            "input": {
                "evidence_id": EVIDENCE_ID,
                "evidence_type": "SOURCE_CLOSE",
                "schema_version": 1,
                "scheme": "EVM_RECEIPT_CONFIRMATIONS",
                "evidence_reference": "eip155:8453/tx/0xabc",
                "verification_state": "FINALIZED",
                "supersedes_evidence_id": null,
            },
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;

    let unauthorized_finalization = attacker
        .call(contract.id(), "finalize_agreement")
        .args_json(json!({
            "agreement_id": AGREEMENT_ID,
            "receipt_bundle_hash": RECEIPT_HASH,
            "terminal_status": "COMPLETED",
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(unauthorized_finalization.is_failure());

    verifier
        .call(contract.id(), "finalize_agreement")
        .args_json(json!({
            "agreement_id": AGREEMENT_ID,
            "receipt_bundle_hash": RECEIPT_HASH,
            "terminal_status": "COMPLETED",
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;

    let receipt: Value = contract
        .call("get_final_receipt")
        .args_json(json!({ "agreement_id": AGREEMENT_ID }))
        .view()
        .await?
        .json()?;
    assert_eq!(receipt["receipt_bundle_hash"], RECEIPT_HASH);
    assert_eq!(receipt["terminal_status"], "COMPLETED");
    assert_eq!(receipt["finalized_by"], verifier.id().as_str());

    let indexed_agreement: Option<String> = contract
        .call("get_agreement_id_by_receipt_hash")
        .args_json(json!({ "receipt_bundle_hash": RECEIPT_HASH }))
        .view()
        .await?
        .json()?;
    assert_eq!(indexed_agreement.as_deref(), Some(AGREEMENT_ID));

    let duplicate_finalization = verifier
        .call(contract.id(), "finalize_agreement")
        .args_json(json!({
            "agreement_id": AGREEMENT_ID,
            "receipt_bundle_hash": RECEIPT_HASH,
            "terminal_status": "COMPLETED",
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    assert!(duplicate_finalization.is_failure());

    Ok(())
}
