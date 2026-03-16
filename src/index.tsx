#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import React, { useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";

type LaunchMode = "inline" | "new-window";

type CodexProfile = {
    name: string;
    homeDirectory: string;
    createdUtc: string;
};

type UsageSource = "sessions" | "none";

type UsageTotals = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    threadCount: number;
    estimatedCostUsd: number;
    unknownPricingRows: number;
};

type ModelUsageRow = {
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    threadCount: number;
    estimatedCostUsd: number | null;
};

type TimeCostRow = {
    period: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    threadCount: number;
    estimatedCostUsd: number;
    unknownPricingRows: number;
};

type PeriodGranularity = "day" | "month";

type ProfileUsage = {
    profile: CodexProfile;
    rows: ModelUsageRow[];
    totals: UsageTotals;
    dailyCosts: TimeCostRow[];
    monthlyCosts: TimeCostRow[];
    source: UsageSource;
};

type TokenSnapshot = {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
};

type ModelPricing = {
    inputPer1M: number;
    cachedInputPer1M: number | null;
    outputPer1M: number;
};

const PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const PRICING_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const PRICING_FAILURE_CACHE_TTL_MS = 1000 * 60 * 5;

type ProfileFileModel = {
    profiles: CodexProfile[];
};

type MainProfileSwitchResult = {
    targetName: string;
    mainHome: string;
    targetHome: string;
    defaultCodexHomeScope: "user" | "process";
    defaultCodexHomeChanged: boolean;
    defaultCodexHomeWarning?: string;
};

class CodexSwitcherError extends Error { }

const AUTH_STATE_FILES = ["auth.json", "cap_sid"] as const;

class ProfileStore {
    private readonly storeDirectory: string;
    private readonly profilesFile: string;
    private readonly lockFile: string;
    private readonly defaultProfilesRoot: string;

    constructor() {
        this.storeDirectory = path.join(this.getAppDataDir(), "CodexSwitcher");
        this.profilesFile = path.join(this.storeDirectory, "profiles.json");
        this.lockFile = path.join(this.storeDirectory, "profiles.lock");
        this.defaultProfilesRoot = path.join(os.homedir(), ".codex-switcher", "profiles");
    }

    async getProfiles(): Promise<CodexProfile[]> {
        return this.withLock(async () => {
            const all = await this.loadUnsafe();
            return all.sort((left, right) => left.name.localeCompare(right.name));
        });
    }

    async getProfile(name: string): Promise<CodexProfile> {
        return this.withLock(async () => {
            const all = await this.loadUnsafe();
            const found = all.find((item) => item.name.toLowerCase() === name.toLowerCase());
            if (!found) {
                throw new CodexSwitcherError(`Profile '${name}' does not exist.`);
            }

            return found;
        });
    }

    async hasProfile(name: string): Promise<boolean> {
        return this.withLock(async () => {
            const all = await this.loadUnsafe();
            return all.some((item) => item.name.toLowerCase() === name.toLowerCase());
        });
    }

    async ensureProfile(name: string, customHome: string): Promise<void> {
        await this.withLock(async () => {
            const all = await this.loadUnsafe();
            if (all.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
                return;
            }

            this.validateName(name);
            const profile: CodexProfile = {
                name,
                homeDirectory: path.resolve(customHome),
                createdUtc: new Date().toISOString(),
            };
            all.push(profile);
            await this.saveUnsafe(all);
            await this.ensureProfileDirectory(profile.homeDirectory);
        });
    }

    async addProfile(name: string, customHome?: string): Promise<CodexProfile> {
        return this.withLock(async () => {
            this.validateName(name);

            const all = await this.loadUnsafe();
            if (all.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
                throw new CodexSwitcherError(`Profile '${name}' already exists.`);
            }

            const homeDirectory = customHome ? path.resolve(customHome) : path.join(this.defaultProfilesRoot, name);
            const profile: CodexProfile = {
                name,
                homeDirectory,
                createdUtc: new Date().toISOString(),
            };
            all.push(profile);
            await this.saveUnsafe(all);
            await this.ensureProfileDirectory(profile.homeDirectory);
            return profile;
        });
    }

    async removeProfile(name: string): Promise<void> {
        await this.withLock(async () => {
            const all = await this.loadUnsafe();
            const filtered = all.filter((item) => item.name.toLowerCase() !== name.toLowerCase());
            if (filtered.length === all.length) {
                throw new CodexSwitcherError(`Profile '${name}' does not exist.`);
            }

            await this.saveUnsafe(filtered);
        });
    }

    async ensureProfileDirectory(profileHome: string): Promise<void> {
        await fs.mkdir(profileHome, { recursive: true });
    }

    private getAppDataDir(): string {
        if (process.platform === "win32") {
            const appData = process.env.APPDATA;
            if (appData && appData.trim().length > 0) {
                return appData;
            }
        }

        return path.join(os.homedir(), ".config");
    }

    private validateName(name: string): void {
        if (!name || name.trim().length === 0) {
            throw new CodexSwitcherError("Profile name cannot be empty.");
        }

        const invalidChars = /[<>:"/\\|?*]/;
        if (invalidChars.test(name)) {
            throw new CodexSwitcherError("Profile name has invalid characters.");
        }
    }

    private async loadUnsafe(): Promise<CodexProfile[]> {
        if (!existsSync(this.profilesFile)) {
            return [];
        }

        const content = await fs.readFile(this.profilesFile, "utf8");
        if (!content.trim()) {
            return [];
        }

        let model: ProfileFileModel;
        try {
            model = JSON.parse(content) as ProfileFileModel;
        } catch {
            throw new CodexSwitcherError("profiles.json is corrupted and could not be parsed.");
        }

        if (!Array.isArray(model.profiles)) {
            return [];
        }

        return model.profiles;
    }

    private async saveUnsafe(profiles: CodexProfile[]): Promise<void> {
        await fs.mkdir(this.storeDirectory, { recursive: true });
        const model: ProfileFileModel = { profiles };
        const json = JSON.stringify(model, null, 2);
        const tempFile = `${this.profilesFile}.tmp`;
        await fs.writeFile(tempFile, json, "utf8");
        await fs.rename(tempFile, this.profilesFile);
    }

    private async withLock<T>(action: () => Promise<T>): Promise<T> {
        await fs.mkdir(this.storeDirectory, { recursive: true });

        const timeoutMs = 10_000;
        const retryMs = 120;
        const start = Date.now();

        while (true) {
            try {
                const lockHandle = await fs.open(this.lockFile, "wx");

                try {
                    await lockHandle.writeFile(`${process.pid}`);
                    return await action();
                } finally {
                    await lockHandle.close();
                    await fs.rm(this.lockFile, { force: true });
                }
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== "EEXIST") {
                    throw error;
                }

                if (Date.now() - start > timeoutMs) {
                    throw new CodexSwitcherError("Timed out waiting for profile store lock.");
                }

                await new Promise((resolve) => {
                    setTimeout(resolve, retryMs);
                });
            }
        }
    }
}

class CodexService {
    private pricingCache: Map<string, ModelPricing> | null = null;
    private pricingCacheExpiresAt = 0;

    constructor(private readonly store: ProfileStore) { }

    async autoDetectMainProfile(): Promise<void> {
        if (await this.store.hasProfile("main")) {
            return;
        }

        const codexHome = this.resolveDefaultCodexHome();
        if (!existsSync(codexHome)) {
            return;
        }

        if (!(await this.isLoggedInAtHome(codexHome))) {
            return;
        }

        await this.store.ensureProfile("main", codexHome);
    }

    async listProfiles(): Promise<CodexProfile[]> {
        return this.store.getProfiles();
    }

    async addProfile(name: string, customHome?: string): Promise<CodexProfile> {
        return this.store.addProfile(name, customHome);
    }

    async removeProfile(name: string): Promise<void> {
        await this.store.removeProfile(name);
    }

    async showProfile(name: string): Promise<CodexProfile> {
        return this.store.getProfile(name);
    }

    async switchMainProfile(targetName: string): Promise<MainProfileSwitchResult> {
        if (!targetName || targetName.trim().length === 0) {
            throw new CodexSwitcherError("Target profile name cannot be empty.");
        }

        if (targetName.toLowerCase() === "main") {
            throw new CodexSwitcherError("Target profile must be different from 'main'.");
        }

        const mainProfile = await this.store.getProfile("main");
        const targetProfile = await this.store.getProfile(targetName);
        await this.store.ensureProfileDirectory(mainProfile.homeDirectory);
        await this.store.ensureProfileDirectory(targetProfile.homeDirectory);
        await this.swapAuthStateBetweenHomes(mainProfile.homeDirectory, targetProfile.homeDirectory);

        const codexHomeSync = await this.syncDefaultCodexHome(mainProfile.homeDirectory);
        return {
            targetName: targetProfile.name,
            mainHome: mainProfile.homeDirectory,
            targetHome: targetProfile.homeDirectory,
            defaultCodexHomeScope: codexHomeSync.scope,
            defaultCodexHomeChanged: codexHomeSync.changed,
            defaultCodexHomeWarning: codexHomeSync.warning,
        };
    }

    private async swapAuthStateBetweenHomes(mainHome: string, targetHome: string): Promise<void> {
        const mainState = new Map<string, Buffer | null>();
        const targetState = new Map<string, Buffer | null>();

        for (const fileName of AUTH_STATE_FILES) {
            mainState.set(fileName, await this.readOptionalFile(path.join(mainHome, fileName)));
            targetState.set(fileName, await this.readOptionalFile(path.join(targetHome, fileName)));
        }

        try {
            await this.writeAuthState(mainHome, targetState);
            await this.writeAuthState(targetHome, mainState);
        } catch (error) {
            await this.writeAuthState(mainHome, mainState).catch(() => undefined);
            await this.writeAuthState(targetHome, targetState).catch(() => undefined);
            const message = error instanceof Error ? error.message : "Unknown file operation error.";
            throw new CodexSwitcherError(`Failed to switch account state: ${message}`);
        }
    }

    private async writeAuthState(homeDirectory: string, state: Map<string, Buffer | null>): Promise<void> {
        for (const fileName of AUTH_STATE_FILES) {
            const fullPath = path.join(homeDirectory, fileName);
            const content = state.get(fileName) ?? null;
            if (content === null) {
                await fs.rm(fullPath, { force: true });
                continue;
            }

            await fs.writeFile(fullPath, content);
        }
    }

    private async readOptionalFile(filePath: string): Promise<Buffer | null> {
        try {
            return await fs.readFile(filePath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
                return null;
            }

            throw error;
        }
    }

    private async syncDefaultCodexHome(codexHome: string): Promise<{ scope: "user" | "process"; changed: boolean; warning?: string }> {
        process.env.CODEX_HOME = codexHome;

        if (process.platform !== "win32") {
            return { scope: "process", changed: true };
        }

        try {
            const currentUserValue = await UserEnvironmentManager.getUserVariable("CODEX_HOME");
            const currentNormalized = currentUserValue.trim().length > 0 ? normalizePath(currentUserValue) : "";
            const nextNormalized = normalizePath(codexHome);
            if (currentNormalized === nextNormalized) {
                return { scope: "user", changed: false };
            }

            await UserEnvironmentManager.setUserVariable("CODEX_HOME", codexHome);
            return { scope: "user", changed: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown failure while updating user CODEX_HOME.";
            return {
                scope: "process",
                changed: true,
                warning: `Switched profiles, but failed to persist user CODEX_HOME: ${message}`,
            };
        }
    }

    async loginProfile(name: string, mode: LaunchMode = "inline"): Promise<number> {
        return this.runProfile(name, ["login"], mode);
    }

    async runProfile(name: string, codexArgs: string[], mode: LaunchMode = "inline"): Promise<number> {
        const profile = await this.store.getProfile(name);
        await this.store.ensureProfileDirectory(profile.homeDirectory);

        if (mode === "new-window") {
            return this.launchCodexInNewWindow(profile, codexArgs);
        }

        return this.launchCodexInline(profile, codexArgs);
    }

    async getProfileLoginStatus(name: string): Promise<{ profile: CodexProfile; loggedIn: boolean }> {
        const profile = await this.store.getProfile(name);
        const loggedIn = await this.isLoggedInAtHome(profile.homeDirectory);
        return { profile, loggedIn };
    }

    async getAllProfilesLoginStatus(): Promise<Array<{ profile: CodexProfile; loggedIn: boolean }>> {
        const profiles = await this.store.getProfiles();
        return Promise.all(
            profiles.map(async (profile) => ({
                profile,
                loggedIn: await this.isLoggedInAtHome(profile.homeDirectory),
            })),
        );
    }

    async getProfileUsage(name: string): Promise<ProfileUsage> {
        const profile = await this.store.getProfile(name);
        const usage = await this.readUsageForHome(profile.homeDirectory);
        return {
            profile,
            ...usage,
        };
    }

    async getAllProfilesUsage(): Promise<ProfileUsage[]> {
        const profiles = await this.store.getProfiles();
        return Promise.all(
            profiles.map(async (profile) => ({
                profile,
                ...(await this.readUsageForHome(profile.homeDirectory)),
            })),
        );
    }

    private async readUsageForHome(codexHome: string): Promise<Omit<ProfileUsage, "profile">> {
        const sessionUsage = await this.readUsageFromSessions(codexHome);
        if (sessionUsage) {
            return sessionUsage;
        }

        return {
            rows: [],
            totals: zeroUsageTotals(),
            dailyCosts: [],
            monthlyCosts: [],
            source: "none",
        };
    }

    private async readUsageFromSessions(codexHome: string): Promise<Omit<ProfileUsage, "profile"> | null> {
        const sessionsRoot = path.join(codexHome, "sessions");
        if (!existsSync(sessionsRoot)) {
            return null;
        }

        const pricingMap = await this.getPricingMap();

        const rolloutFiles = await this.collectRolloutFiles(sessionsRoot);
        if (rolloutFiles.length === 0) {
            return null;
        }

        const usageByModel = new Map<string, Omit<ModelUsageRow, "estimatedCostUsd">>();
        const dailyTotals = new Map<string, UsageTotals>();
        const monthlyTotals = new Map<string, UsageTotals>();
        let threadsWithUsage = 0;

        for (const file of rolloutFiles) {
            const content = await fs.readFile(file, "utf8");
            const usageForFile = this.parseRolloutUsageByModel(content);
            if (usageForFile.size === 0) {
                continue;
            }

            threadsWithUsage += 1;
            const periods = extractPeriodsFromRolloutPath(file, sessionsRoot);
            const dayTotals = getOrCreatePeriodTotals(dailyTotals, periods.day);
            const monthTotals = getOrCreatePeriodTotals(monthlyTotals, periods.month);
            dayTotals.threadCount += 1;
            monthTotals.threadCount += 1;

            for (const [model, usage] of usageForFile) {
                const modelCost = estimateCostUsd(
                    {
                        model,
                        inputTokens: usage.inputTokens,
                        cachedInputTokens: usage.cachedInputTokens,
                        outputTokens: usage.outputTokens,
                    },
                    pricingMap,
                );

                addSnapshotToTotals(dayTotals, usage, modelCost);
                addSnapshotToTotals(monthTotals, usage, modelCost);

                const existing = usageByModel.get(model);
                if (existing) {
                    existing.inputTokens += usage.inputTokens;
                    existing.cachedInputTokens += usage.cachedInputTokens;
                    existing.outputTokens += usage.outputTokens;
                    existing.reasoningOutputTokens += usage.reasoningOutputTokens;
                    existing.totalTokens += usage.totalTokens;
                    existing.threadCount += 1;
                    continue;
                }

                usageByModel.set(model, {
                    model,
                    inputTokens: usage.inputTokens,
                    cachedInputTokens: usage.cachedInputTokens,
                    outputTokens: usage.outputTokens,
                    reasoningOutputTokens: usage.reasoningOutputTokens,
                    totalTokens: usage.totalTokens,
                    threadCount: 1,
                });
            }
        }

        if (usageByModel.size === 0) {
            return null;
        }

        const rows: ModelUsageRow[] = [...usageByModel.values()]
            .map((row) => ({
                ...row,
                estimatedCostUsd: estimateCostUsd(row, pricingMap),
            }))
            .sort((left, right) => right.totalTokens - left.totalTokens);

        const totals = rows.reduce<UsageTotals>((acc, row) => {
            acc.inputTokens += row.inputTokens;
            acc.cachedInputTokens += row.cachedInputTokens;
            acc.outputTokens += row.outputTokens;
            acc.reasoningOutputTokens += row.reasoningOutputTokens;
            acc.totalTokens += row.totalTokens;
            if (row.estimatedCostUsd === null) {
                acc.unknownPricingRows += 1;
            } else {
                acc.estimatedCostUsd += row.estimatedCostUsd;
            }
            return acc;
        }, zeroUsageTotals());

        totals.threadCount = threadsWithUsage;

        const dailyCosts = mapPeriodTotalsToRows(dailyTotals);
        const monthlyCosts = mapPeriodTotalsToRows(monthlyTotals);

        return {
            rows,
            totals,
            dailyCosts,
            monthlyCosts,
            source: "sessions",
        };
    }

    private parseRolloutUsageByModel(content: string): Map<string, TokenSnapshot> {
        const usageByModel = new Map<string, TokenSnapshot>();
        const lines = content.split(/\r?\n/);

        let currentModel = "unknown";
        let previousTotal = zeroTokenSnapshot();

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.length === 0) {
                continue;
            }

            let parsed: {
                type?: string;
                payload?: Record<string, unknown>;
            };

            try {
                parsed = JSON.parse(line) as {
                    type?: string;
                    payload?: Record<string, unknown>;
                };
            } catch {
                continue;
            }

            if (parsed.type === "turn_context") {
                const modelValue = parsed.payload?.model;
                if (typeof modelValue === "string" && modelValue.trim().length > 0) {
                    currentModel = modelValue.trim();
                }
                continue;
            }

            if (parsed.type !== "event_msg") {
                continue;
            }

            const payloadType = parsed.payload?.type;
            if (payloadType !== "token_count") {
                continue;
            }

            const info = parsed.payload?.info;
            if (!info || typeof info !== "object") {
                continue;
            }

            const infoObject = info as Record<string, unknown>;
            const totalUsage = infoObject.total_token_usage;
            const lastUsage = infoObject.last_token_usage;

            let delta: TokenSnapshot | null = null;

            if (totalUsage && typeof totalUsage === "object") {
                const currentTotal = parseTokenSnapshot(totalUsage as Record<string, unknown>);
                delta = subtractSnapshots(currentTotal, previousTotal);
                previousTotal = currentTotal;
            } else if (lastUsage && typeof lastUsage === "object") {
                delta = parseTokenSnapshot(lastUsage as Record<string, unknown>);
            }

            if (!delta || isZeroSnapshot(delta)) {
                continue;
            }

            const modelUsage = usageByModel.get(currentModel);
            if (modelUsage) {
                modelUsage.inputTokens += delta.inputTokens;
                modelUsage.cachedInputTokens += delta.cachedInputTokens;
                modelUsage.outputTokens += delta.outputTokens;
                modelUsage.reasoningOutputTokens += delta.reasoningOutputTokens;
                modelUsage.totalTokens += delta.totalTokens;
            } else {
                usageByModel.set(currentModel, { ...delta });
            }
        }

        return usageByModel;
    }

    private async getPricingMap(): Promise<Map<string, ModelPricing>> {
        const now = Date.now();
        if (this.pricingCache && now < this.pricingCacheExpiresAt) {
            return this.pricingCache;
        }

        try {
            let html: string | null = null;
            const maxAttempts = 3;

            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                try {
                    const response = await fetch(PRICING_URL);
                    if (!response.ok) {
                        throw new CodexSwitcherError(`Pricing request failed with status ${response.status}.`);
                    }

                    html = await response.text();
                    break;
                } catch {
                    if (attempt >= maxAttempts) {
                        throw new CodexSwitcherError("Pricing request failed after retries.");
                    }

                    await new Promise((resolve) => {
                        setTimeout(resolve, 500 * attempt);
                    });
                }
            }

            if (!html) {
                throw new CodexSwitcherError("Pricing request returned empty response.");
            }

            const parsed = parsePricingFromHtml(html);
            this.pricingCache = parsed;
            this.pricingCacheExpiresAt = now + (parsed.size > 0 ? PRICING_CACHE_TTL_MS : PRICING_FAILURE_CACHE_TTL_MS);
            return parsed;
        } catch {
            this.pricingCache = new Map();
            this.pricingCacheExpiresAt = now + PRICING_FAILURE_CACHE_TTL_MS;
            return this.pricingCache;
        }
    }

    private async collectRolloutFiles(root: string): Promise<string[]> {
        const files: string[] = [];
        const queue = [root];

        while (queue.length > 0) {
            const current = queue.pop();
            if (!current) {
                continue;
            }

            const entries = await fs.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    queue.push(fullPath);
                    continue;
                }

                if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
                    files.push(fullPath);
                }
            }
        }

        return files;
    }

    private resolveDefaultCodexHome(): string {
        const explicitCodexHome = process.env.CODEX_HOME;
        if (explicitCodexHome && explicitCodexHome.trim().length > 0) {
            return path.resolve(explicitCodexHome);
        }

        return path.join(os.homedir(), ".codex");
    }

    private async isLoggedInAtHome(codexHome: string): Promise<boolean> {
        let codexCommand: string;
        try {
            codexCommand = resolveCodexCommand();
        } catch {
            return false;
        }

        const result = spawnCodexSync(codexCommand, ["login", "status"], {
            env: {
                ...process.env,
                CODEX_HOME: codexHome,
            },
            stdio: "ignore",
            timeout: 8_000,
        });

        return result.status === 0;
    }

    private async launchCodexInline(profile: CodexProfile, codexArgs: string[]): Promise<number> {
        const codexCommand = resolveCodexCommand();
        const child = spawnCodex(codexCommand, codexArgs, {
            stdio: "inherit",
            env: {
                ...process.env,
                CODEX_HOME: profile.homeDirectory,
            },
            cwd: process.cwd(),
        });

        return new Promise<number>((resolve, reject) => {
            child.on("error", (error) => {
                reject(new CodexSwitcherError(`Could not start Codex CLI: ${error.message}`));
            });

            child.on("exit", (code) => {
                resolve(code ?? 1);
            });
        });
    }

    private async launchCodexInNewWindow(profile: CodexProfile, codexArgs: string[]): Promise<number> {
        const codexCommand = resolveCodexCommand();

        if (process.platform !== "win32") {
            const child = spawnCodex(codexCommand, codexArgs, {
                detached: true,
                stdio: "ignore",
                env: {
                    ...process.env,
                    CODEX_HOME: profile.homeDirectory,
                },
            });
            child.unref();
            return 0;
        }

        const script = buildPowerShellLaunchScript(profile.homeDirectory, codexCommand, codexArgs);
        const encodedScript = encodePowerShellScript(script);
        const child = spawn(
            "cmd.exe",
            [
                "/c",
                "start",
                "",
                "powershell.exe",
                "-NoLogo",
                "-NoExit",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                encodedScript,
            ],
            {
                detached: true,
                stdio: "ignore",
            },
        );

        child.unref();
        return 0;
    }
}

class UserEnvironmentManager {
    static async getUserVariable(name: string): Promise<string> {
        this.ensureWindows();
        const escapedName = escapePowerShellString(name);
        const script = `[Environment]::GetEnvironmentVariable('${escapedName}','User')`;
        const output = await runPowerShell(script);
        return output.trim();
    }

    static async setUserVariable(name: string, value: string): Promise<void> {
        this.ensureWindows();
        const escapedName = escapePowerShellString(name);
        const escapedValue = escapePowerShellString(value);
        const script = `[Environment]::SetEnvironmentVariable('${escapedName}','${escapedValue}','User')`;
        await runPowerShell(script);
    }

    private static ensureWindows(): void {
        if (process.platform !== "win32") {
            throw new CodexSwitcherError("User environment variable updates are currently supported on Windows only.");
        }
    }
}

function normalizePath(value: string): string {
    const expanded = value.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`);

    try {
        return path.resolve(expanded).replace(/[\\/]+$/, "").toLowerCase();
    } catch {
        return expanded.replace(/[\\/]+$/, "").toLowerCase();
    }
}

function escapePowerShellString(value: string): string {
    return value.replace(/'/g, "''");
}

function runPowerShell(script: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        const child = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            {
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (error) => {
            reject(new CodexSwitcherError(`PowerShell failed: ${error.message}`));
        });

        child.on("exit", (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            reject(new CodexSwitcherError(stderr.trim() || "PowerShell command failed."));
        });
    });
}

function resolveCodexCommand(): string {
    if (process.platform !== "win32") {
        return "codex";
    }

    const pathValue = process.env.PATH ?? "";
    const segments = pathValue.split(path.delimiter).filter((item) => item.trim().length > 0);

    for (const segment of segments) {
        const cmdCandidate = path.join(segment, "codex.cmd");
        if (existsSync(cmdCandidate)) {
            return cmdCandidate;
        }

        const exeCandidate = path.join(segment, "codex.exe");
        if (existsSync(exeCandidate)) {
            return exeCandidate;
        }

        const plainCandidate = path.join(segment, "codex");
        if (existsSync(plainCandidate)) {
            return plainCandidate;
        }
    }

    return "codex";
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(value: number | null): string {
    if (value === null) {
        return "n/a";
    }

    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
    }).format(value);
}

function zeroTokenSnapshot(): TokenSnapshot {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
    };
}

function zeroUsageTotals(): UsageTotals {
    return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        threadCount: 0,
        estimatedCostUsd: 0,
        unknownPricingRows: 0,
    };
}

function toSafeTokenNumber(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.floor(value));
}

function parseTokenSnapshot(raw: Record<string, unknown>): TokenSnapshot {
    const inputTokens = toSafeTokenNumber(raw.input_tokens);
    const cachedInputTokens = toSafeTokenNumber(raw.cached_input_tokens);
    const outputTokens = toSafeTokenNumber(raw.output_tokens);
    const reasoningOutputTokens = toSafeTokenNumber(raw.reasoning_output_tokens);
    const totalFromPayload = toSafeTokenNumber(raw.total_tokens);

    return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens: totalFromPayload > 0 ? totalFromPayload : inputTokens + cachedInputTokens + outputTokens,
    };
}

function subtractSnapshots(current: TokenSnapshot, previous: TokenSnapshot): TokenSnapshot {
    return {
        inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
        cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
        outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
        reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
        totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
    };
}

function isZeroSnapshot(value: TokenSnapshot): boolean {
    return (
        value.inputTokens === 0
        && value.cachedInputTokens === 0
        && value.outputTokens === 0
        && value.reasoningOutputTokens === 0
        && value.totalTokens === 0
    );
}

function normalizeModelId(model: string): string {
    const cleaned = decodeHtmlEntities(model)
        .replace(/<[^>]*>/g, "")
        .replace(/\s*\([^)]*\)\s*$/g, "")
        .trim()
        .toLowerCase();
    const trimmed = cleaned;
    if (trimmed.includes("/")) {
        const parts = trimmed.split("/").filter((item) => item.length > 0);
        if (parts.length > 0) {
            return parts[parts.length - 1]!;
        }
    }

    return trimmed;
}

function parsePricingFromHtml(html: string): Map<string, ModelPricing> {
    const pricing = parsePricingFromAstroProps(html);
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
    let match: RegExpExecArray | null;
    while ((match = rowRegex.exec(html)) !== null) {
        const model = normalizeModelId(match[1] ?? "");
        if (model.length === 0) {
            continue;
        }

        const inputPer1M = parseDollarValue(match[2]);
        const cachedInputPer1M = parseDollarValueOrNull(match[3]);
        const outputPer1M = parseDollarValue(match[4]);
        if (inputPer1M === null || outputPer1M === null) {
            continue;
        }

        setPricingIfMissing(pricing, model, inputPer1M, cachedInputPer1M, outputPer1M);
    }

    return pricing;
}

function parsePricingFromAstroProps(html: string): Map<string, ModelPricing> {
    const pricing = new Map<string, ModelPricing>();
    const propsRegex = /component-export="TextTokenPricingTables"[^>]*props="([^"]+)"/g;

    for (const match of html.matchAll(propsRegex)) {
        const decodedProps = decodeHtmlEntities(match[1] ?? "");
        if (decodedProps.length === 0) {
            continue;
        }

        let rawProps: unknown;
        try {
            rawProps = JSON.parse(decodedProps);
        } catch {
            continue;
        }

        const props = reviveAstroSerializedValue(rawProps) as { tier?: unknown; rows?: unknown };
        if (props.tier !== "standard" || !Array.isArray(props.rows)) {
            continue;
        }

        for (const row of props.rows) {
            if (!Array.isArray(row) || row.length < 4) {
                continue;
            }

            const model = normalizeModelId(String(row[0] ?? ""));
            const inputPer1M = toFiniteNumber(row[1]);
            const cachedInputPer1M = toFiniteNumber(row[2]);
            const outputPer1M = toFiniteNumber(row[3]);
            if (model.length === 0 || inputPer1M === null || outputPer1M === null) {
                continue;
            }

            setPricingIfMissing(pricing, model, inputPer1M, cachedInputPer1M, outputPer1M);
        }
    }

    return pricing;
}

function setPricingIfMissing(
    pricing: Map<string, ModelPricing>,
    model: string,
    inputPer1M: number,
    cachedInputPer1M: number | null,
    outputPer1M: number,
): void {
    if (pricing.has(model)) {
        return;
    }

    pricing.set(model, {
        inputPer1M,
        cachedInputPer1M,
        outputPer1M,
    });
}

function parseDollarValue(raw: string | undefined): number | null {
    if (!raw) {
        return null;
    }

    const cleaned = raw.replace(/<[^>]*>/g, "").replace(/\$/g, "").replace(/,/g, "").trim();
    if (!/^\d+(\.\d+)?$/.test(cleaned)) {
        return null;
    }

    const value = Number.parseFloat(cleaned);
    return Number.isFinite(value) ? value : null;
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"');
}

function reviveAstroSerializedValue(value: unknown): unknown {
    return reviveAstroNode([0, value]);
}

function reviveAstroNode(value: unknown): unknown {
    if (!Array.isArray(value) || value.length !== 2) {
        return value;
    }

    const [kind, payload] = value;
    switch (kind) {
        case 0:
            if (typeof payload !== "object" || payload === null) {
                return payload;
            }

            return Object.fromEntries(
                Object.entries(payload).map(([key, entry]) => [key, reviveAstroNode(entry)]),
            );
        case 1:
            return Array.isArray(payload) ? payload.map((entry) => reviveAstroNode(entry)) : [];
        default:
            return payload;
    }
}

function toFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseDollarValueOrNull(raw: string | undefined): number | null {
    if (!raw) {
        return null;
    }

    const cleaned = raw.replace(/<[^>]*>/g, "").trim();
    if (cleaned === "-") {
        return null;
    }

    return parseDollarValue(cleaned);
}

function resolveModelPricing(model: string, pricingMap: Map<string, ModelPricing>): ModelPricing | null {
    const normalized = normalizeModelId(model);
    const candidates = new Set<string>([normalized]);

    if (normalized.endsWith("-latest")) {
        candidates.add(normalized.replace(/-latest$/, ""));
    }

    if (/\-\d{4}\-\d{2}\-\d{2}$/.test(normalized)) {
        candidates.add(normalized.replace(/\-\d{4}\-\d{2}\-\d{2}$/, ""));
    }

    for (const candidate of candidates) {
        const resolved = pricingMap.get(candidate);
        if (resolved) {
            return resolved;
        }
    }

    return null;
}

function estimateCostUsd(
    row: Pick<ModelUsageRow, "model" | "inputTokens" | "cachedInputTokens" | "outputTokens">,
    pricingMap: Map<string, ModelPricing>,
): number | null {
    const pricing = resolveModelPricing(row.model, pricingMap);
    if (!pricing) {
        return null;
    }

    const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;
    const inputCost = (row.inputTokens / 1_000_000) * pricing.inputPer1M;
    const cachedCost = (row.cachedInputTokens / 1_000_000) * cachedRate;
    const outputCost = (row.outputTokens / 1_000_000) * pricing.outputPer1M;

    return inputCost + cachedCost + outputCost;
}

function getOrCreatePeriodTotals(map: Map<string, UsageTotals>, period: string): UsageTotals {
    const existing = map.get(period);
    if (existing) {
        return existing;
    }

    const created = zeroUsageTotals();
    map.set(period, created);
    return created;
}

function addSnapshotToTotals(totals: UsageTotals, usage: TokenSnapshot, estimatedCostUsd: number | null): void {
    totals.inputTokens += usage.inputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.reasoningOutputTokens += usage.reasoningOutputTokens;
    totals.totalTokens += usage.totalTokens;

    if (estimatedCostUsd === null) {
        totals.unknownPricingRows += 1;
    } else {
        totals.estimatedCostUsd += estimatedCostUsd;
    }
}

function mapPeriodTotalsToRows(periodMap: Map<string, UsageTotals>): TimeCostRow[] {
    return [...periodMap.entries()]
        .map(([period, totals]) => ({
            period,
            inputTokens: totals.inputTokens,
            cachedInputTokens: totals.cachedInputTokens,
            outputTokens: totals.outputTokens,
            reasoningOutputTokens: totals.reasoningOutputTokens,
            totalTokens: totals.totalTokens,
            threadCount: totals.threadCount,
            estimatedCostUsd: totals.estimatedCostUsd,
            unknownPricingRows: totals.unknownPricingRows,
        }))
        .sort((left, right) => right.period.localeCompare(left.period));
}

function extractPeriodsFromRolloutPath(filePath: string, sessionsRoot: string): { day: string; month: string } {
    const relative = path.relative(sessionsRoot, filePath).replace(/\\/g, "/");
    const match = relative.match(/^(\d{4})\/(\d{2})\/(\d{2})\//);
    if (!match) {
        return { day: "unknown", month: "unknown" };
    }

    const [, year, month, day] = match;
    return {
        day: `${year}-${month}-${day}`,
        month: `${year}-${month}`,
    };
}

function getPeriodRows(profileUsage: ProfileUsage, granularity: PeriodGranularity): TimeCostRow[] {
    return granularity === "day" ? profileUsage.dailyCosts : profileUsage.monthlyCosts;
}

function buildModelUsageLines(usageByProfile: ProfileUsage[]): string[] {
    const lines: string[] = [];
    const globalTotals = zeroUsageTotals();

    for (const profileUsage of usageByProfile) {
        lines.push(`Profile: ${profileUsage.profile.name}`);

        if (profileUsage.source === "none" || profileUsage.rows.length === 0) {
            lines.push("  No local usage events found.");
            lines.push("");
            continue;
        }

        for (const row of profileUsage.rows) {
            lines.push(
                `  - ${row.model}: input ${formatNumber(row.inputTokens)}, cached ${formatNumber(row.cachedInputTokens)}, output ${formatNumber(row.outputTokens)}, total ${formatNumber(row.totalTokens)}, threads ${row.threadCount}, cost ${formatUsd(row.estimatedCostUsd)}`,
            );
        }

        const profileUnknownPricing = profileUsage.rows.filter((item) => item.estimatedCostUsd === null).length;
        lines.push(
            `  Total: input ${formatNumber(profileUsage.totals.inputTokens)}, cached ${formatNumber(profileUsage.totals.cachedInputTokens)}, output ${formatNumber(profileUsage.totals.outputTokens)}, total ${formatNumber(profileUsage.totals.totalTokens)}, threads ${profileUsage.totals.threadCount}, cost ${formatUsd(profileUsage.totals.estimatedCostUsd)}${profileUnknownPricing > 0 ? ` (${profileUnknownPricing} model row(s) without pricing)` : ""}`,
        );
        lines.push("");

        globalTotals.inputTokens += profileUsage.totals.inputTokens;
        globalTotals.cachedInputTokens += profileUsage.totals.cachedInputTokens;
        globalTotals.outputTokens += profileUsage.totals.outputTokens;
        globalTotals.reasoningOutputTokens += profileUsage.totals.reasoningOutputTokens;
        globalTotals.totalTokens += profileUsage.totals.totalTokens;
        globalTotals.threadCount += profileUsage.totals.threadCount;
        globalTotals.estimatedCostUsd += profileUsage.totals.estimatedCostUsd;
        globalTotals.unknownPricingRows += profileUsage.totals.unknownPricingRows;
    }

    lines.push(
        `Grand total: input ${formatNumber(globalTotals.inputTokens)}, cached ${formatNumber(globalTotals.cachedInputTokens)}, output ${formatNumber(globalTotals.outputTokens)}, total ${formatNumber(globalTotals.totalTokens)}, threads ${globalTotals.threadCount}, cost ${formatUsd(globalTotals.estimatedCostUsd)}${globalTotals.unknownPricingRows > 0 ? ` (${globalTotals.unknownPricingRows} model row(s) without pricing)` : ""}`,
    );
    lines.push(`Pricing source: ${PRICING_URL} (standard tier).`);

    return lines;
}

function buildPeriodUsageLines(usageByProfile: ProfileUsage[], granularity: PeriodGranularity): string[] {
    const lines: string[] = [];
    const globalTotals = zeroUsageTotals();

    for (const profileUsage of usageByProfile) {
        lines.push(`Profile: ${profileUsage.profile.name}`);
        const periodRows = getPeriodRows(profileUsage, granularity);

        if (profileUsage.source === "none" || periodRows.length === 0) {
            lines.push(`  No ${granularity} usage events found.`);
            lines.push("");
            continue;
        }

        for (const row of periodRows) {
            lines.push(
                `  - ${row.period}: input ${formatNumber(row.inputTokens)}, cached ${formatNumber(row.cachedInputTokens)}, output ${formatNumber(row.outputTokens)}, total ${formatNumber(row.totalTokens)}, threads ${row.threadCount}, cost ${formatUsd(row.estimatedCostUsd)}${row.unknownPricingRows > 0 ? ` (${row.unknownPricingRows} row(s) without pricing)` : ""}`,
            );
        }

        lines.push(
            `  Total: input ${formatNumber(profileUsage.totals.inputTokens)}, cached ${formatNumber(profileUsage.totals.cachedInputTokens)}, output ${formatNumber(profileUsage.totals.outputTokens)}, total ${formatNumber(profileUsage.totals.totalTokens)}, threads ${profileUsage.totals.threadCount}, cost ${formatUsd(profileUsage.totals.estimatedCostUsd)}${profileUsage.totals.unknownPricingRows > 0 ? ` (${profileUsage.totals.unknownPricingRows} row(s) without pricing)` : ""}`,
        );
        lines.push("");

        globalTotals.inputTokens += profileUsage.totals.inputTokens;
        globalTotals.cachedInputTokens += profileUsage.totals.cachedInputTokens;
        globalTotals.outputTokens += profileUsage.totals.outputTokens;
        globalTotals.reasoningOutputTokens += profileUsage.totals.reasoningOutputTokens;
        globalTotals.totalTokens += profileUsage.totals.totalTokens;
        globalTotals.threadCount += profileUsage.totals.threadCount;
        globalTotals.estimatedCostUsd += profileUsage.totals.estimatedCostUsd;
        globalTotals.unknownPricingRows += profileUsage.totals.unknownPricingRows;
    }

    lines.push(
        `Grand ${granularity} total: input ${formatNumber(globalTotals.inputTokens)}, cached ${formatNumber(globalTotals.cachedInputTokens)}, output ${formatNumber(globalTotals.outputTokens)}, total ${formatNumber(globalTotals.totalTokens)}, threads ${globalTotals.threadCount}, cost ${formatUsd(globalTotals.estimatedCostUsd)}${globalTotals.unknownPricingRows > 0 ? ` (${globalTotals.unknownPricingRows} row(s) without pricing)` : ""}`,
    );
    lines.push(`Pricing source: ${PRICING_URL} (standard tier).`);

    return lines;
}

function needsShell(command: string): boolean {
    const lower = command.toLowerCase();
    return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

function spawnCodex(
    command: string,
    args: string[],
    options: {
        stdio: "inherit" | "ignore";
        env: NodeJS.ProcessEnv;
        cwd?: string;
        detached?: boolean;
    },
) {
    if (process.platform === "win32" && needsShell(command)) {
        const wrapped = [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ");
        return spawn("cmd.exe", ["/d", "/s", "/c", wrapped], {
            stdio: options.stdio,
            env: options.env,
            cwd: options.cwd,
            detached: options.detached,
        });
    }

    return spawn(command, args, {
        stdio: options.stdio,
        env: options.env,
        cwd: options.cwd,
        detached: options.detached,
    });
}

function spawnCodexSync(
    command: string,
    args: string[],
    options: {
        env: NodeJS.ProcessEnv;
        stdio: "ignore";
        timeout: number;
    },
) {
    if (process.platform === "win32" && needsShell(command)) {
        const wrapped = [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ");
        return spawnSync("cmd.exe", ["/d", "/s", "/c", wrapped], {
            env: options.env,
            stdio: options.stdio,
            timeout: options.timeout,
        });
    }

    return spawnSync(command, args, {
        env: options.env,
        stdio: options.stdio,
        timeout: options.timeout,
    });
}

function quoteCmdArgument(value: string): string {
    if (value.length === 0) {
        return "\"\"";
    }

    const escaped = value.replace(/"/g, '\\"');
    if (/\s/.test(escaped) || /[&|<>^]/.test(escaped)) {
        return `"${escaped}"`;
    }

    return escaped;
}

function buildPowerShellLaunchScript(codexHome: string, codexCommand: string, args: string[]): string {
    const command = [`& ${quotePowerShell(codexCommand)}`, ...args.map((item) => quotePowerShell(item))].join(" ");
    return `$env:CODEX_HOME = ${quotePowerShell(codexHome)}; ${command}`;
}

function encodePowerShellScript(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

function quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function printHelp(): void {
    console.log("Codex Switcher");
    console.log("");
    console.log("Run without arguments to open interactive mode.");
    console.log("");
    console.log("Commands:");
    console.log("  add <profile> [--home <path>]             Create profile");
    console.log("  list                                      List profiles");
    console.log("  show <profile>                            Show profile details");
    console.log("  remove <profile>                          Remove profile");
    console.log("  login <profile> [--new-window]            Run 'codex login' in profile");
    console.log("  run <profile> [--new-window] [--yolo] [-- args]  Run codex with profile context");
    console.log("  spawn <profile> [--yolo] [-- args]        Open codex in new window");
    console.log("  switch-main <profile>                     Swap account auth with target, keep main threads/settings");
    console.log("  status                                    List login status for all profiles");
    console.log("  usage [profile] [--period <model|day|month>]  Show usage and estimated API cost");
    console.log("  help                                      Show this help");
}

async function executeCommand(service: CodexService, args: string[]): Promise<number> {
    const command = args[0]?.toLowerCase();

    switch (command) {
        case "help":
        case "-h":
        case "--help": {
            printHelp();
            return 0;
        }
        case "list": {
            const profiles = await service.listProfiles();
            if (profiles.length === 0) {
                console.log("No profiles found.");
                return 0;
            }

            profiles.forEach((profile) => {
                console.log(`- ${profile.name}  (${profile.homeDirectory})`);
            });
            return 0;
        }
        case "status": {
            const statuses = await service.getAllProfilesLoginStatus();
            if (statuses.length === 0) {
                console.log("No profiles found.");
                return 0;
            }

            statuses.forEach((item) => {
                const label = item.loggedIn ? "Logged in" : "Not logged in";
                console.log(`- ${item.profile.name}  (${label})  [${item.profile.homeDirectory}]`);
            });
            return 0;
        }
        case "usage": {
            let profileName: string | undefined;
            let period: "model" | PeriodGranularity = "model";

            for (let index = 1; index < args.length; index += 1) {
                const token = args[index];
                if (token === "--period") {
                    const next = args[index + 1]?.toLowerCase();
                    if (!next || (next !== "model" && next !== "day" && next !== "month")) {
                        throw new CodexSwitcherError("Usage: usage [profile] [--period <model|day|month>]");
                    }
                    period = next;
                    index += 1;
                    continue;
                }

                if (token.startsWith("--")) {
                    throw new CodexSwitcherError(`Unknown option: ${token}`);
                }

                if (!profileName) {
                    profileName = token;
                    continue;
                }

                throw new CodexSwitcherError("Usage: usage [profile] [--period <model|day|month>]");
            }

            const usageRows = profileName ? [await service.getProfileUsage(profileName)] : await service.getAllProfilesUsage();
            if (usageRows.length === 0) {
                console.log("No profiles found.");
                return 0;
            }

            const lines = period === "model" ? buildModelUsageLines(usageRows) : buildPeriodUsageLines(usageRows, period);
            lines.forEach((line) => console.log(line));
            return 0;
        }
        case "add":
        case "create": {
            if (args.length < 2) {
                throw new CodexSwitcherError("Usage: add <profile> [--home <path>]");
            }

            const profileName = args[1];
            let customHome: string | undefined;

            for (let index = 2; index < args.length; index += 1) {
                const token = args[index];
                if (token === "--home") {
                    const next = args[index + 1];
                    if (!next) {
                        throw new CodexSwitcherError("Missing value after --home.");
                    }
                    customHome = next;
                    index += 1;
                    continue;
                }

                throw new CodexSwitcherError(`Unknown option: ${token}`);
            }

            const profile = await service.addProfile(profileName, customHome);
            console.log(`Created profile '${profile.name}'`);
            console.log(`CodexHome: ${profile.homeDirectory}`);
            console.log(`Next: codex-switcher login ${profile.name}`);
            return 0;
        }
        case "show": {
            if (args.length !== 2) {
                throw new CodexSwitcherError("Usage: show <profile>");
            }

            const profile = await service.showProfile(args[1]);
            console.log(`Name: ${profile.name}`);
            console.log(`CodexHome: ${profile.homeDirectory}`);
            console.log(`CreatedUtc: ${profile.createdUtc}`);
            return 0;
        }
        case "remove":
        case "delete": {
            if (args.length !== 2) {
                throw new CodexSwitcherError("Usage: remove <profile>");
            }

            await service.removeProfile(args[1]);
            console.log(`Removed profile '${args[1]}'`);
            return 0;
        }
        case "login": {
            if (args.length < 2) {
                throw new CodexSwitcherError("Usage: login <profile> [--new-window]");
            }

            const mode: LaunchMode = args.includes("--new-window") ? "new-window" : "inline";
            const exitCode = await service.loginProfile(args[1], mode);
            return exitCode;
        }
        case "switch-main": {
            if (args.length !== 2) {
                throw new CodexSwitcherError("Usage: switch-main <profile>");
            }

            const switched = await service.switchMainProfile(args[1]);
            console.log(`Switched main account using '${switched.targetName}'.`);
            console.log(`main home (unchanged): ${switched.mainHome}`);
            console.log(`${switched.targetName} home (unchanged): ${switched.targetHome}`);
            console.log(`Swapped auth files: ${AUTH_STATE_FILES.join(", ")}`);
            if (switched.defaultCodexHomeWarning) {
                console.log(`Warning: ${switched.defaultCodexHomeWarning}`);
            } else if (switched.defaultCodexHomeScope === "user") {
                console.log(switched.defaultCodexHomeChanged
                    ? "Updated user CODEX_HOME. Open a new terminal before running plain 'codex'."
                    : "User CODEX_HOME already matched main profile. Open a new terminal if current shell is stale.");
            } else {
                console.log("Updated CODEX_HOME for this process only.");
            }
            return 0;
        }
        case "spawn":
        case "open": {
            if (args.length < 2) {
                throw new CodexSwitcherError("Usage: spawn <profile> [--yolo] [-- <args...>]");
            }

            const profileName = args[1];
            const passThroughIndex = args.indexOf("--");
            const optionTokens = passThroughIndex >= 0 ? args.slice(2, passThroughIndex) : args.slice(2);
            const invalidOption = optionTokens.find((item) => item !== "--yolo");
            if (invalidOption) {
                throw new CodexSwitcherError(`Unknown option: ${invalidOption}`);
            }

            const useYolo = optionTokens.includes("--yolo");
            const codexArgs = passThroughIndex >= 0 ? args.slice(passThroughIndex + 1) : [];
            if (useYolo && !codexArgs.includes("--yolo")) {
                codexArgs.unshift("--yolo");
            }

            return service.runProfile(profileName, codexArgs, "new-window");
        }
        case "run": {
            if (args.length < 2) {
                throw new CodexSwitcherError("Usage: run <profile> [--new-window] [--yolo] [-- <args...>]");
            }

            const profileName = args[1];
            const passThroughIndex = args.indexOf("--");
            const optionTokens = passThroughIndex >= 0 ? args.slice(2, passThroughIndex) : args.slice(2);
            const invalidOption = optionTokens.find((item) => item !== "--new-window" && item !== "--yolo");
            if (invalidOption) {
                throw new CodexSwitcherError(`Unknown option: ${invalidOption}`);
            }

            const mode: LaunchMode = optionTokens.includes("--new-window") ? "new-window" : "inline";
            const useYolo = optionTokens.includes("--yolo");
            const codexArgs = passThroughIndex >= 0 ? args.slice(passThroughIndex + 1) : [];
            if (useYolo && !codexArgs.includes("--yolo")) {
                codexArgs.unshift("--yolo");
            }

            return service.runProfile(profileName, codexArgs, mode);
        }
        default:
            throw new CodexSwitcherError(`Unknown command: ${args[0]}`);
    }
}

type MenuAction =
    | "list"
    | "add"
    | "login"
    | "open"
    | "open-yolo"
    | "switch-main"
    | "status"
    | "usage"
    | "remove"
    | "help"
    | "quit";

type MenuItem = { id: MenuAction; label: string };

const MENU_ITEMS: MenuItem[] = [
    { id: "list", label: "List profiles" },
    { id: "add", label: "Add profile" },
    { id: "login", label: "Login profile (new window)" },
    { id: "open", label: "Open profile session (new window)" },
    { id: "open-yolo", label: "Open profile session (new window, --yolo)" },
    { id: "switch-main", label: "Switch main profile account" },
    { id: "status", label: "Check status (all profiles)" },
    { id: "usage", label: "Show usage by model (all profiles)" },
    { id: "remove", label: "Remove profile" },
    { id: "help", label: "Show help" },
    { id: "quit", label: "Exit" },
];

type ViewState =
    | { mode: "menu" }
    | { mode: "prompt"; action: MenuAction; prompt: string; value: string }
    | { mode: "select"; action: MenuAction; title: string; options: string[]; selectedIndex: number }
    | { mode: "message"; lines: string[] };

function InteractiveApp(props: { service: CodexService }): React.JSX.Element {
    const { exit } = useApp();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [viewState, setViewState] = useState<ViewState>({ mode: "menu" });
    const [busy, setBusy] = useState(false);

    const selectedItem = useMemo(() => MENU_ITEMS[selectedIndex]!, [selectedIndex]);

    useInput((input, key) => {
        if (busy) {
            return;
        }

        if (viewState.mode === "menu") {
            if (key.upArrow) {
                setSelectedIndex((current) => (current === 0 ? MENU_ITEMS.length - 1 : current - 1));
                return;
            }

            if (key.downArrow) {
                setSelectedIndex((current) => (current === MENU_ITEMS.length - 1 ? 0 : current + 1));
                return;
            }

            if (key.return) {
                void handleMenuAction(selectedItem.id);
            }

            return;
        }

        if (viewState.mode === "prompt") {
            if (key.escape) {
                setViewState({ mode: "menu" });
                return;
            }

            if (key.return) {
                void handlePromptSubmit(viewState.action, viewState.value.trim());
                return;
            }

            if (key.backspace || key.delete) {
                setViewState((current) => {
                    if (current.mode !== "prompt") {
                        return current;
                    }
                    return {
                        ...current,
                        value: current.value.slice(0, -1),
                    };
                });
                return;
            }

            if (input && !key.ctrl && !key.meta) {
                setViewState((current) => {
                    if (current.mode !== "prompt") {
                        return current;
                    }
                    return {
                        ...current,
                        value: `${current.value}${input}`,
                    };
                });
            }

            return;
        }

        if (viewState.mode === "select") {
            if (key.escape) {
                setViewState({ mode: "menu" });
                return;
            }

            if (key.upArrow) {
                setViewState((current) => {
                    if (current.mode !== "select") {
                        return current;
                    }

                    const nextIndex = current.selectedIndex === 0 ? current.options.length - 1 : current.selectedIndex - 1;
                    return { ...current, selectedIndex: nextIndex };
                });
                return;
            }

            if (key.downArrow) {
                setViewState((current) => {
                    if (current.mode !== "select") {
                        return current;
                    }

                    const nextIndex = current.selectedIndex === current.options.length - 1 ? 0 : current.selectedIndex + 1;
                    return { ...current, selectedIndex: nextIndex };
                });
                return;
            }

            if (key.return) {
                const selected = viewState.options[viewState.selectedIndex];
                if (selected) {
                    void handleSelectSubmit(viewState.action, selected);
                }
                return;
            }

            return;
        }

        if (viewState.mode === "message") {
            setViewState({ mode: "menu" });
        }
    });

    async function handleMenuAction(action: MenuAction): Promise<void> {
        if (action === "quit") {
            exit();
            return;
        }

        if (action === "help") {
            setViewState({
                mode: "message",
                lines: [
                    "Use arrow keys + Enter.",
                    "Create profile uses typed input; other profile actions use selectors.",
                    "Use the --yolo menu entry to launch a profile directly in yolo mode.",
                    "Switch main account swaps auth only; main threads/settings stay in main home.",
                    "Usage menu includes model/day/month cost views.",
                    "No-arg mode is interactive; command mode still works.",
                    "Press any key to return.",
                ],
            });
            return;
        }

        if (action === "add") {
            setViewState({ mode: "prompt", action, prompt: "Profile name:", value: "" });
            return;
        }

        if (action === "login") {
            await openProfileSelector(action, "Select profile to login");
            return;
        }

        if (action === "open") {
            await openProfileSelector(action, "Select profile to open in new window");
            return;
        }

        if (action === "open-yolo") {
            await openProfileSelector(action, "Select profile to open in new window (--yolo)");
            return;
        }

        if (action === "remove") {
            await openProfileSelector(action, "Select profile to remove");
            return;
        }

        if (action === "switch-main") {
            await openProfileSelector(action, "Select profile to swap with main");
            return;
        }

        if (action === "usage") {
            setViewState({
                mode: "select",
                action,
                title: "Usage submenu",
                options: ["By model (all profiles)", "Cost by day (all profiles)", "Cost by month (all profiles)"],
                selectedIndex: 0,
            });
            return;
        }

        setBusy(true);
        try {
            if (action === "list") {
                const profiles = await props.service.listProfiles();
                if (profiles.length === 0) {
                    setViewState({ mode: "message", lines: ["No profiles found.", "Press any key to return."] });
                } else {
                    setViewState({
                        mode: "message",
                        lines: [...profiles.map((item) => `- ${item.name} (${item.homeDirectory})`), "Press any key to return."],
                    });
                }
            }

            if (action === "status") {
                const statuses = await props.service.getAllProfilesLoginStatus();
                if (statuses.length === 0) {
                    setViewState({ mode: "message", lines: ["No profiles found.", "Press any key to return."] });
                } else {
                    setViewState({
                        mode: "message",
                        lines: [
                            ...statuses.map((item) => `- ${item.profile.name}: ${item.loggedIn ? "Logged in" : "Not logged in"}`),
                            "Press any key to return.",
                        ],
                    });
                }
            }

        } catch (error) {
            setViewState({
                mode: "message",
                lines: [formatError(error), "Press any key to return."],
            });
        } finally {
            setBusy(false);
        }
    }

    async function openProfileSelector(action: Extract<MenuAction, "login" | "open" | "open-yolo" | "remove" | "switch-main">, title: string): Promise<void> {
        const profiles = await props.service.listProfiles();
        if (profiles.length === 0) {
            setViewState({ mode: "message", lines: ["No profiles found.", "Press any key to return."] });
            return;
        }

        const options = action === "switch-main"
            ? profiles.filter((item) => item.name.toLowerCase() !== "main").map((item) => item.name)
            : profiles.map((item) => item.name);

        if (options.length === 0) {
            setViewState({ mode: "message", lines: ["No swappable profiles found.", "Press any key to return."] });
            return;
        }

        setViewState({
            mode: "select",
            action,
            title,
            options,
            selectedIndex: 0,
        });
    }

    async function handlePromptSubmit(action: MenuAction, value: string): Promise<void> {
        if (!value) {
            setViewState({ mode: "menu" });
            return;
        }

        setBusy(true);
        try {
            if (action === "add") {
                const profile = await props.service.addProfile(value);
                setViewState({
                    mode: "message",
                    lines: [
                        `Created profile '${profile.name}'.`,
                        `CodexHome: ${profile.homeDirectory}`,
                        "Press any key to return.",
                    ],
                });
            } else {
                setViewState({ mode: "menu" });
            }
        } catch (error) {
            setViewState({
                mode: "message",
                lines: [formatError(error), "Press any key to return."],
            });
        } finally {
            setBusy(false);
        }
    }

    async function handleSelectSubmit(action: MenuAction, selectedOption: string): Promise<void> {
        setBusy(true);
        try {
            if (action === "login") {
                await props.service.loginProfile(selectedOption, "new-window");
                setViewState({
                    mode: "message",
                    lines: [`Opened login for '${selectedOption}' in a new window.`, "Press any key to return."],
                });
                return;
            }

            if (action === "open") {
                await props.service.runProfile(selectedOption, [], "new-window");
                setViewState({
                    mode: "message",
                    lines: [
                        `Opened '${selectedOption}' in a new window.`,
                        "Tip: use command mode for custom args, e.g. spawn <profile> -- <args>",
                        "Press any key to return.",
                    ],
                });
                return;
            }

            if (action === "open-yolo") {
                await props.service.runProfile(selectedOption, ["--yolo"], "new-window");
                setViewState({
                    mode: "message",
                    lines: [`Opened '${selectedOption}' in a new window with --yolo.`, "Press any key to return."],
                });
                return;
            }

            if (action === "remove") {
                await props.service.removeProfile(selectedOption);
                setViewState({
                    mode: "message",
                    lines: [`Removed profile '${selectedOption}'.`, "Press any key to return."],
                });
                return;
            }

            if (action === "switch-main") {
                const switched = await props.service.switchMainProfile(selectedOption);
                const syncLine = switched.defaultCodexHomeWarning
                    ? `Warning: ${switched.defaultCodexHomeWarning}`
                    : switched.defaultCodexHomeScope === "user"
                        ? (switched.defaultCodexHomeChanged
                            ? "Updated user CODEX_HOME. Open a new terminal for plain 'codex'."
                            : "User CODEX_HOME already matched main profile. Open a new terminal if needed.")
                        : "Updated CODEX_HOME for this process only.";
                setViewState({
                    mode: "message",
                    lines: [
                        `Switched main account using '${switched.targetName}'.`,
                        `main home (unchanged): ${switched.mainHome}`,
                        `${switched.targetName} home (unchanged): ${switched.targetHome}`,
                        `Swapped auth files: ${AUTH_STATE_FILES.join(", ")}`,
                        syncLine,
                        "Press any key to return.",
                    ],
                });
                return;
            }

            if (action === "usage") {
                const usageByProfile = await props.service.getAllProfilesUsage();
                if (usageByProfile.length === 0) {
                    setViewState({
                        mode: "message",
                        lines: ["No profiles found.", "Press any key to return."],
                    });
                    return;
                }

                const lines = selectedOption === "Cost by day (all profiles)"
                    ? buildPeriodUsageLines(usageByProfile, "day")
                    : selectedOption === "Cost by month (all profiles)"
                        ? buildPeriodUsageLines(usageByProfile, "month")
                        : buildModelUsageLines(usageByProfile);

                setViewState({
                    mode: "message",
                    lines: [...lines, "Press any key to return."],
                });
                return;
            }

            setViewState({ mode: "menu" });
        } catch (error) {
            setViewState({
                mode: "message",
                lines: [formatError(error), "Press any key to return."],
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Box flexDirection="column" paddingX={1}>
            <Text color="cyan">Codex Switcher</Text>
            <Text dimColor>Use arrow keys + Enter. Press Esc to go back.</Text>
            <Box marginTop={1} flexDirection="column">
                {viewState.mode === "menu" && (
                    <>
                        {MENU_ITEMS.map((item, index) => (
                            <Text key={item.id} color={index === selectedIndex ? "green" : undefined}>
                                {index === selectedIndex ? "›" : " "} {item.label}
                            </Text>
                        ))}
                    </>
                )}

                {viewState.mode === "prompt" && (
                    <Box flexDirection="column">
                        <Text>{viewState.prompt}</Text>
                        <Text color="yellow">{`> ${viewState.value}`}</Text>
                    </Box>
                )}

                {viewState.mode === "select" && (
                    <Box flexDirection="column">
                        <Text>{viewState.title}</Text>
                        {viewState.options.map((option, index) => (
                            <Text key={option} color={index === viewState.selectedIndex ? "green" : undefined}>
                                {index === viewState.selectedIndex ? "›" : " "} {option}
                            </Text>
                        ))}
                    </Box>
                )}

                {viewState.mode === "message" && (
                    <Box flexDirection="column">
                        {viewState.lines.map((line, index) => (
                            <Text key={`${line}-${index}`}>{line}</Text>
                        ))}
                    </Box>
                )}

                {busy && <Text color="yellow">Working...</Text>}
            </Box>
        </Box>
    );
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return `Error: ${error.message}`;
    }

    return "Error: Unknown failure";
}

async function runInteractive(service: CodexService): Promise<void> {
    await new Promise<void>((resolve) => {
        const ink = render(<InteractiveApp service={service} />);

        ink.waitUntilExit().then(() => {
            resolve();
        });
    });
}

async function main(): Promise<void> {
    const service = new CodexService(new ProfileStore());
    await service.autoDetectMainProfile();

    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "interactive" || args[0] === "menu") {
        await runInteractive(service);
        return;
    }

    const exitCode = await executeCommand(service, args);
    process.exitCode = exitCode;
}

main().catch((error: unknown) => {
    console.error(formatError(error));
    process.exitCode = 1;
});
