import { utils as ethersUtils } from "ethers";
import winston from "winston";
import { typeguards } from "@across-protocol/sdk";
import {
  BigNumber,
  CHAIN_IDs,
  dedupArray,
  toBNWei,
  assert,
  isDefined,
  readFileSync,
  toBN,
  replaceAddressCase,
  ethers,
  TOKEN_SYMBOLS_MAP,
} from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import * as Constants from "../common/Constants";
import { InventoryConfig, TokenBalanceConfig, isAliasConfig } from "../interfaces/InventoryManagement";

export class RelayerConfig extends CommonConfig {
  readonly externalIndexer: boolean;
  readonly indexerPath: string;
  readonly inventoryConfig: InventoryConfig;
  readonly debugProfitability: boolean;
  // Whether token price fetch failures will be ignored when computing relay profitability.
  // If this is false, the relayer will throw an error when fetching prices fails.
  readonly skipRelays: boolean;
  readonly skipRebalancing: boolean;
  readonly sendingRelaysEnabled: boolean;
  readonly sendingRebalancesEnabled: boolean;
  readonly sendingMessageRelaysEnabled: boolean;
  readonly relayerTokens: string[];
  readonly relayerOriginChains: number[] = [];
  readonly relayerDestinationChains: number[] = [];
  readonly relayerGasPadding: BigNumber;
  readonly relayerGasMultiplier: BigNumber;
  readonly relayerMessageGasMultiplier: BigNumber;
  readonly minRelayerFeePct: BigNumber;
  readonly acceptInvalidFills: boolean;

  constructor(env: ProcessEnv) {
    const {
      RELAYER_ORIGIN_CHAINS,
      RELAYER_DESTINATION_CHAINS,
      DEBUG_PROFITABILITY,
      RELAYER_GAS_MESSAGE_MULTIPLIER,
      RELAYER_GAS_MULTIPLIER,
      RELAYER_GAS_PADDING,
      RELAYER_EXTERNAL_INVENTORY_CONFIG,
      RELAYER_INVENTORY_CONFIG,
      RELAYER_TOKENS,
      SEND_RELAYS,
      SEND_REBALANCES,
      SEND_MESSAGE_RELAYS,
      SKIP_RELAYS,
      MIN_RELAYER_FEE_PCT,
      RELAYER_EXTERNAL_INDEXER,
      RELAYER_SPOKEPOOL_INDEXER_PATH,
    } = env;
    super(env);

    // External indexing is dependent on looping mode being configured.
    this.externalIndexer = this.pollingDelay > 0 && RELAYER_EXTERNAL_INDEXER === "true";
    this.indexerPath = RELAYER_SPOKEPOOL_INDEXER_PATH ?? Constants.RELAYER_DEFAULT_SPOKEPOOL_INDEXER;

    // Empty means all chains.
    this.relayerOriginChains = JSON.parse(RELAYER_ORIGIN_CHAINS ?? "[]");
    this.relayerDestinationChains = JSON.parse(RELAYER_DESTINATION_CHAINS ?? "[]");

    // Empty means all tokens.
    this.relayerTokens = RELAYER_TOKENS
      ? JSON.parse(RELAYER_TOKENS).map((token) => ethers.utils.getAddress(token))
      : [];
    this.minRelayerFeePct = toBNWei(MIN_RELAYER_FEE_PCT || Constants.RELAYER_MIN_FEE_PCT);

    assert(
      !isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG) || !isDefined(RELAYER_INVENTORY_CONFIG),
      "Concurrent inventory management configurations detected."
    );
    try {
      this.inventoryConfig = isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG)
        ? JSON.parse(readFileSync(RELAYER_EXTERNAL_INVENTORY_CONFIG))
        : JSON.parse(RELAYER_INVENTORY_CONFIG ?? "{}");
    } catch (err) {
      const msg = typeguards.isError(err) ? err.message : (err as Record<string, unknown>)?.code;
      throw new Error(`Inventory config error (${msg ?? "unknown error"})`);
    }

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.

      const { inventoryConfig } = this;

      // Default to 1 Eth on the target chains and wrapping the rest to WETH.
      inventoryConfig.wrapEtherThreshold = toBNWei(inventoryConfig.wrapEtherThreshold ?? 1);

      inventoryConfig.wrapEtherThresholdPerChain ??= {};
      inventoryConfig.wrapEtherTarget = inventoryConfig.wrapEtherTarget
        ? toBNWei(inventoryConfig.wrapEtherTarget)
        : inventoryConfig.wrapEtherThreshold; // default to wrapping ETH to threshold, same as target.

      inventoryConfig.wrapEtherTargetPerChain ??= {};
      assert(
        inventoryConfig.wrapEtherThreshold.gte(inventoryConfig.wrapEtherTarget),
        `default wrapEtherThreshold ${inventoryConfig.wrapEtherThreshold} must be >= default wrapEtherTarget ${inventoryConfig.wrapEtherTarget}`
      );

      // Validate the per chain target and thresholds for wrapping ETH:
      const wrapThresholds = inventoryConfig.wrapEtherThresholdPerChain;
      const wrapTargets = inventoryConfig.wrapEtherTargetPerChain;
      Object.keys(inventoryConfig.wrapEtherThresholdPerChain).forEach((chainId) => {
        if (wrapThresholds[chainId] !== undefined) {
          wrapThresholds[chainId] = toBNWei(wrapThresholds[chainId]); // Promote to 18 decimals.
        }
      });

      Object.keys(inventoryConfig.wrapEtherTargetPerChain).forEach((chainId) => {
        if (wrapTargets[chainId] !== undefined) {
          wrapTargets[chainId] = toBNWei(wrapTargets[chainId]); // Promote to 18 decimals.

          // Check newly set target against threshold
          const threshold = wrapThresholds[chainId] ?? inventoryConfig.wrapEtherThreshold;
          const target = wrapTargets[chainId];
          assert(
            threshold.gte(target),
            `Chain ${chainId} wrapEtherThresholdPerChain ${threshold} must be >= wrapEtherTargetPerChain ${target}`
          );
        }
      });

      const parseTokenConfig = (
        l1Token: string,
        chainId: string,
        rawTokenConfig: TokenBalanceConfig
      ): TokenBalanceConfig => {
        const { targetPct, thresholdPct, unwrapWethThreshold, unwrapWethTarget, targetOverageBuffer } = rawTokenConfig;
        const tokenConfig: TokenBalanceConfig = { targetPct, thresholdPct, targetOverageBuffer };

        assert(
          targetPct !== undefined && thresholdPct !== undefined,
          `Bad config. Must specify targetPct, thresholdPct for ${l1Token} on ${chainId}`
        );
        assert(
          toBN(thresholdPct).lte(toBN(targetPct)),
          `Bad config. thresholdPct<=targetPct for ${l1Token} on ${chainId}`
        );
        tokenConfig.targetPct = toBNWei(targetPct).div(100);
        tokenConfig.thresholdPct = toBNWei(thresholdPct).div(100);

        // Default to 150% the targetPct. targetOverageBuffer does not have to be defined so that no existing configs
        // are broken. This is a reasonable default because it allows the relayer to be a bit more flexible in
        // holding more tokens than the targetPct, but perhaps a better default is 100%
        tokenConfig.targetOverageBuffer = toBNWei(targetOverageBuffer ?? "1.5");

        // For WETH, also consider any unwrap target/threshold.
        if (l1Token === TOKEN_SYMBOLS_MAP.WETH.symbol) {
          if (unwrapWethThreshold !== undefined) {
            tokenConfig.unwrapWethThreshold = toBNWei(unwrapWethThreshold);
          }
          tokenConfig.unwrapWethTarget = toBNWei(unwrapWethTarget ?? 2);
        }

        return tokenConfig;
      };

      const rawTokenConfigs = inventoryConfig?.tokenConfig ?? {};
      const tokenConfigs = (inventoryConfig.tokenConfig = {});
      Object.keys(rawTokenConfigs).forEach((l1Token) => {
        // If the l1Token is a symbol, resolve the correct address.
        const effectiveL1Token = ethersUtils.isAddress(l1Token)
          ? l1Token
          : TOKEN_SYMBOLS_MAP[l1Token].addresses[this.hubPoolChainId];
        assert(effectiveL1Token !== undefined, `No token identified for ${l1Token}`);

        tokenConfigs[effectiveL1Token] ??= {};
        const hubTokenConfig = rawTokenConfigs[l1Token];

        if (isAliasConfig(hubTokenConfig)) {
          Object.keys(hubTokenConfig).forEach((symbol) => {
            Object.keys(hubTokenConfig[symbol]).forEach((chainId) => {
              const rawTokenConfig = hubTokenConfig[symbol][chainId];
              const effectiveSpokeToken = TOKEN_SYMBOLS_MAP[symbol].addresses[chainId];

              tokenConfigs[effectiveL1Token][effectiveSpokeToken] ??= {};
              tokenConfigs[effectiveL1Token][effectiveSpokeToken][chainId] = parseTokenConfig(
                l1Token,
                chainId,
                rawTokenConfig
              );
            });
          });
        } else {
          Object.keys(hubTokenConfig).forEach((chainId) => {
            const rawTokenConfig = hubTokenConfig[chainId];
            tokenConfigs[effectiveL1Token][chainId] = parseTokenConfig(l1Token, chainId, rawTokenConfig);
          });
        }
      });
    }

    this.debugProfitability = DEBUG_PROFITABILITY === "true";
    this.relayerGasPadding = toBNWei(RELAYER_GAS_PADDING || Constants.DEFAULT_RELAYER_GAS_PADDING);
    this.relayerGasMultiplier = toBNWei(RELAYER_GAS_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MULTIPLIER);
    this.relayerMessageGasMultiplier = toBNWei(
      RELAYER_GAS_MESSAGE_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER
    );
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingRebalancesEnabled = SEND_REBALANCES === "true";
    this.sendingMessageRelaysEnabled = SEND_MESSAGE_RELAYS === "true";
    this.skipRelays = SKIP_RELAYS === "true";
    this.skipRebalancing = true;
  }

  /**
   * @notice Loads additional configuration state that can only be known after we know all chains that we're going to
   * support. Warns or throws if any of the configurations are not valid.
   * @param chainIdIndices All expected chain ID's that could be supported by this config.
   * @param logger Optional logger object.
   */
  override validate(chainIds: number[], logger: winston.Logger): void {
    const { relayerOriginChains, relayerDestinationChains } = this;
    const relayerChainIds =
      relayerOriginChains.length > 0 && relayerDestinationChains.length > 0
        ? dedupArray([...relayerOriginChains, ...relayerDestinationChains])
        : chainIds;

    const ignoredChainIds = chainIds.filter(
      (chainId) => !relayerChainIds.includes(chainId) && chainId !== CHAIN_IDs.BOBA
    );
    if (ignoredChainIds.length > 0 && logger) {
      logger.debug({
        at: "RelayerConfig::validate",
        message: `Ignoring ${ignoredChainIds.length} chains.`,
        ignoredChainIds,
      });
    }

    // Only validate config for chains that the relayer cares about.
    super.validate(relayerChainIds, logger);
  }
}
