# Anomaly Report — Issues With No "In Progress" Transition (2026)

**Generated:** 2026-04-12  
**Window:** 2026-01-01 → 2026-04-12  
**Scope:** All 6 boards · Work items only (Epics and Sub-tasks excluded)  
**Definition:** Issues created since 2026-01-01 that have no changelog entry where `toValue` matches any of the 22 configured "in progress" status names.

These issues are excluded from cycle-time and lead-time percentile calculations. Issues that are purely in "To Do" (never completed) are expected; the more concerning entries are those in a terminal status (Done, Cancelled, Won't Do) with no in-progress evidence — they represent work completed outside the tracked workflow.

---

## Summary

| Board | Total anomalies | To Do | Done (no workflow) | Other terminal |
|-------|-----------------|-------|--------------------|----------------|
| ACC   | 8               | 8     | 0                  | 0              |
| BPT   | 58              | 44    | 2                  | 12             |
| DATA  | 2               | 2     | 0                  | 0              |
| OCS   | 7               | 6     | 1                  | 0              |
| PLAT  | 53              | 34    | 10                 | 9              |
| SPS   | 16              | 2     | 2                  | 12             |
| **Total** | **144**     | **96**| **15**             | **33**         |

> **"Done (no workflow)"** — issues in a terminal Done/Released status with no in-progress transition. These are the highest-priority entries to investigate as they suggest work was either done outside Jira or transition logging was skipped.

---

## ACC (8 issues)

| Key | Type | Summary | Status | Created |
|-----|------|---------|--------|---------|
| [ACC-44](https://mypassglobal.atlassian.net/browse/ACC-44) | Task | Enable Equipment management for specific business partners | To Do | 2026-03-23 |
| [ACC-48](https://mypassglobal.atlassian.net/browse/ACC-48) | Task | Deploy WPS to prod | To Do | 2026-03-25 |
| [ACC-51](https://mypassglobal.atlassian.net/browse/ACC-51) | Task | [OC] Remove 'Equipment and Chemicals' from RR modal | To Do | 2026-03-25 |
| [ACC-53](https://mypassglobal.atlassian.net/browse/ACC-53) | Task | Equipment Pipeline slack notifications | To Do | 2026-03-31 |
| [ACC-54](https://mypassglobal.atlassian.net/browse/ACC-54) | Task | Claude skill for local review | To Do | 2026-03-31 |
| [ACC-55](https://mypassglobal.atlassian.net/browse/ACC-55) | Task | Refactor backend file structure and base test classes | To Do | 2026-04-01 |
| [ACC-56](https://mypassglobal.atlassian.net/browse/ACC-56) | Task | Spike: Backend user permissions | To Do | 2026-04-02 |
| [ACC-59](https://mypassglobal.atlassian.net/browse/ACC-59) | Task | Automation \| Manage equipment feature | To Do | 2026-04-09 |

---

## BPT (58 issues)

| Key | Type | Summary | Status | Created |
|-----|------|---------|--------|---------|
| [BPT-28](https://mypassglobal.atlassian.net/browse/BPT-28) | Story | Emails and Receipts (Existing Send Grid) | To Do | 2026-02-11 |
| [BPT-37](https://mypassglobal.atlassian.net/browse/BPT-37) | Story | Stripe Migration of Customers from Old to New Billing System | To Do | 2026-02-16 |
| [BPT-45](https://mypassglobal.atlassian.net/browse/BPT-45) | Story | Kong Onboarding | To Do | 2026-02-16 |
| [BPT-48](https://mypassglobal.atlassian.net/browse/BPT-48) | Story | Audit requirement | To Do | 2026-02-17 |
| [BPT-57](https://mypassglobal.atlassian.net/browse/BPT-57) | Story | API to Activate Portal | To Do | 2026-02-27 |
| [BPT-58](https://mypassglobal.atlassian.net/browse/BPT-58) | Story | POST API to Deactivate Portal | To Do | 2026-02-27 |
| [BPT-59](https://mypassglobal.atlassian.net/browse/BPT-59) | Task | Invoice and Downgrade logic | To Do | 2026-02-27 |
| [BPT-66](https://mypassglobal.atlassian.net/browse/BPT-66) | Story | Forward subscription for affiliate/schedule | To Do | 2026-03-04 |
| [BPT-68](https://mypassglobal.atlassian.net/browse/BPT-68) | Story | Price migration API (Yearly prices changes) | To Do | 2026-03-04 |
| [BPT-69](https://mypassglobal.atlassian.net/browse/BPT-69) | Story | Route Billing Middleware API Calls Through Kong | To Do | 2026-03-04 |
| [BPT-71](https://mypassglobal.atlassian.net/browse/BPT-71) | Story | Upgrade for invoice - Manage your subscription | To Do | 2026-03-04 |
| [BPT-74](https://mypassglobal.atlassian.net/browse/BPT-74) | Story | Reporting Needs | To Do | 2026-03-10 |
| [BPT-76](https://mypassglobal.atlassian.net/browse/BPT-76) | Task | New Pricing Tier | To Do | 2026-03-12 |
| [BPT-79](https://mypassglobal.atlassian.net/browse/BPT-79) | Story | Test Automation: Create Business Partner with new Billing options | To Do | 2026-03-16 |
| [BPT-80](https://mypassglobal.atlassian.net/browse/BPT-80) | Story | Sub Sync | To Do | 2026-03-17 |
| [BPT-81](https://mypassglobal.atlassian.net/browse/BPT-81) | Story | Test Automation: Verify New Business Partner Portal | To Do | 2026-03-17 |
| [BPT-89](https://mypassglobal.atlassian.net/browse/BPT-89) | Story | API to Export Billing Data to New Billing Middleware | To Do | 2026-03-18 |
| [BPT-90](https://mypassglobal.atlassian.net/browse/BPT-90) | Bug | BP with restricted billing disabled has access to portal with no active subscription | **Done** | 2026-03-19 |
| [BPT-92](https://mypassglobal.atlassian.net/browse/BPT-92) | Story | [UI & Backend] Billing middleware API for subscription lock in v3 core service | Cancelled | 2026-03-20 |
| [BPT-93](https://mypassglobal.atlassian.net/browse/BPT-93) | Story | Cache api | To Do | 2026-03-23 |
| [BPT-94](https://mypassglobal.atlassian.net/browse/BPT-94) | Story | Update UI for Billing and Subscription screen | To Do | 2026-03-23 |
| [BPT-95](https://mypassglobal.atlassian.net/browse/BPT-95) | Story | Update UI for add subscription flow | To Do | 2026-03-23 |
| [BPT-96](https://mypassglobal.atlassian.net/browse/BPT-96) | Story | [Test] Display tax breakdown in preview | To Do | 2026-03-23 |
| [BPT-97](https://mypassglobal.atlassian.net/browse/BPT-97) | Story | [Test Ticket] Prorata Calculation | To Do | 2026-03-23 |
| [BPT-98](https://mypassglobal.atlassian.net/browse/BPT-98) | Story | [Testing Ticket] Retry Schedule | To Do | 2026-03-23 |
| [BPT-99](https://mypassglobal.atlassian.net/browse/BPT-99) | Story | New pricing tier/ Switch new Stripe API | To Do | 2026-03-23 |
| [BPT-100](https://mypassglobal.atlassian.net/browse/BPT-100) | Story | Ampltitude Tracking | To Do | 2026-03-23 |
| [BPT-101](https://mypassglobal.atlassian.net/browse/BPT-101) | Story | Upgrading and Downgrading for Invoice and Credit Card Customers | To Do | 2026-03-23 |
| [BPT-102](https://mypassglobal.atlassian.net/browse/BPT-102) | Story | [Testing Ticket] Test that Stripe Native Payment Emails are sent | To Do | 2026-03-23 |
| [BPT-103](https://mypassglobal.atlassian.net/browse/BPT-103) | Story | Stripe Integration with Hubspot (Customer Success Data) | To Do | 2026-03-23 |
| [BPT-104](https://mypassglobal.atlassian.net/browse/BPT-104) | Story | [Test Only] Display GST by line items on Invoice | To Do | 2026-03-23 |
| [BPT-105](https://mypassglobal.atlassian.net/browse/BPT-105) | Story | Test Automation: Create Business Partner with new billing system enabled | To Do | 2026-03-23 |
| [BPT-106](https://mypassglobal.atlassian.net/browse/BPT-106) | Story | Test Automation: Set up subscription for Business Partner in new billing system [Tiered Plan] | To Do | 2026-03-23 |
| [BPT-107](https://mypassglobal.atlassian.net/browse/BPT-107) | Story | Test Automation: Set up subscription for Business Partner in new billing system [Per person Plan] | To Do | 2026-03-23 |
| [BPT-108](https://mypassglobal.atlassian.net/browse/BPT-108) | Story | Test Automation: Subscription Invoice Checkout and content validation | To Do | 2026-03-23 |
| [BPT-109](https://mypassglobal.atlassian.net/browse/BPT-109) | Story | Test Automation: Manage Subscription | To Do | 2026-03-23 |
| [BPT-110](https://mypassglobal.atlassian.net/browse/BPT-110) | Story | Test Automation: Affiliate Subscriptions & Personnel usage | To Do | 2026-03-23 |
| [BPT-112](https://mypassglobal.atlassian.net/browse/BPT-112) | Story | Automatic Reconcillation of Invoice Payments | To Do | 2026-03-24 |
| [BPT-113](https://mypassglobal.atlassian.net/browse/BPT-113) | Story | Onboarding of Chilean Customers | To Do | 2026-03-24 |
| [BPT-114](https://mypassglobal.atlassian.net/browse/BPT-114) | Story | [Test Only] Subscription Re-enablement Testing — Legacy BP & v3 Returning Customers | To Do | 2026-03-25 |
| [BPT-124](https://mypassglobal.atlassian.net/browse/BPT-124) | Task | Stripe Migration (Customer data from Stripe A -> Stripe B) | To Do | 2026-03-26 |
| [BPT-125](https://mypassglobal.atlassian.net/browse/BPT-125) | Task | Spike: Partial copy | To Do | 2026-03-26 |
| [BPT-126](https://mypassglobal.atlassian.net/browse/BPT-126) | Task | Internal Migration | To Do | 2026-03-26 |
| [BPT-127](https://mypassglobal.atlassian.net/browse/BPT-127) | Task | Recreate subscriptions | To Do | 2026-03-26 |
| [BPT-128](https://mypassglobal.atlassian.net/browse/BPT-128) | Task | SPIKE: Migration toolkit | To Do | 2026-03-26 |
| [BPT-131](https://mypassglobal.atlassian.net/browse/BPT-131) | Task | Accounts Locked | To Do | 2026-03-27 |
| [BPT-133](https://mypassglobal.atlassian.net/browse/BPT-133) | Story | Update Upgrade Prompt 'Manage Button' so it takes the user to the billing & subscription screen | **Done** | 2026-03-27 |
| [BPT-141](https://mypassglobal.atlassian.net/browse/BPT-141) | Task | How do we handle when billing middleware is down | To Do | 2026-03-30 |
| [BPT-143](https://mypassglobal.atlassian.net/browse/BPT-143) | Bug | Google look up for non-AU countries not formatted correctly | To Do | 2026-03-30 |
| [BPT-146](https://mypassglobal.atlassian.net/browse/BPT-146) | Bug | Update subscription API tests to test discounts and free trials are implemented properly | To Do | 2026-03-31 |
| [BPT-147](https://mypassglobal.atlassian.net/browse/BPT-147) | Bug | No subscription found, when trying to add new personnel with active subscription | Cancelled | 2026-04-01 |
| [BPT-152](https://mypassglobal.atlassian.net/browse/BPT-152) | Bug | Update "Change Billing Method" text to "Edit Billing Configuration" for Business Partners on New Billing System | To Do | 2026-04-08 |
| [BPT-154](https://mypassglobal.atlassian.net/browse/BPT-154) | Task | SPIKE: Investigation Resource Request and Supplier's Relationship | To Do | 2026-04-09 |
| [BPT-159](https://mypassglobal.atlassian.net/browse/BPT-159) | Story | GET: Import Resource Req API | To Do | 2026-04-10 |
| [BPT-160](https://mypassglobal.atlassian.net/browse/BPT-160) | Story | GET: Search API | To Do | 2026-04-10 |
| [BPT-161](https://mypassglobal.atlassian.net/browse/BPT-161) | Story | GET: Import Resource Request Details | To Do | 2026-04-10 |
| [BPT-162](https://mypassglobal.atlassian.net/browse/BPT-162) | Story | POST: Import Resource Request | To Do | 2026-04-10 |
| [BPT-165](https://mypassglobal.atlassian.net/browse/BPT-165) | Story | Add info message for new billing customers | To Do | 2026-04-10 |

---

## DATA (2 issues)

| Key | Type | Summary | Status | Created |
|-----|------|---------|--------|---------|
| [DATA-242](https://mypassglobal.atlassian.net/browse/DATA-242) | Story | Migrate repo and pipelines to DevOps | To Do | 2026-01-12 |
| [DATA-311](https://mypassglobal.atlassian.net/browse/DATA-311) | Story | Create Compliance Dashboard to be used for Embedding POC | To Do | 2026-03-10 |

---

## OCS (7 issues)

| Key | Type | Summary | Status | Created |
|-----|------|---------|--------|---------|
| [OCS-976](https://mypassglobal.atlassian.net/browse/OCS-976) | Task | Fix failed contract automation scripts | **Done** | 2026-03-06 |
| [OCS-981](https://mypassglobal.atlassian.net/browse/OCS-981) | Task | Update Create Resource Request public API | To Do | 2026-03-12 |
| [OCS-998](https://mypassglobal.atlassian.net/browse/OCS-998) | Story | Include Asset Onboarding into 3-dot-menu on Asset | To Do | 2026-03-26 |
| [OCS-1000](https://mypassglobal.atlassian.net/browse/OCS-1000) | Story | Activate/Deactivate Asset Onboarding Enforcement | To Do | 2026-03-26 |
| [OCS-1001](https://mypassglobal.atlassian.net/browse/OCS-1001) | Story | Create Asset Onboarding template \| UI | To Do | 2026-03-26 |
| [OCS-1003](https://mypassglobal.atlassian.net/browse/OCS-1003) | Story | DMS \| Add Saving the Links ability to DMS and update the required Endpoints. | To Do | 2026-03-27 |
| [OCS-1004](https://mypassglobal.atlassian.net/browse/OCS-1004) | Story | Create Asset Onboarding template \| BE | To Do | 2026-03-27 |

---

## PLAT (53 issues)

| Key | Type | Summary | Status | Created |
|-----|------|---------|--------|---------|
| [PLAT-1121](https://mypassglobal.atlassian.net/browse/PLAT-1121) | Task | Happy Sheen Sendgrid, Konsole and Configcat access - TTB-4310 | **Done** | 2026-01-08 |
| [PLAT-1122](https://mypassglobal.atlassian.net/browse/PLAT-1122) | Task | Aldene Sendgrid, Konsole and Configcat access - TTB-4308 | **Done** | 2026-01-08 |
| [PLAT-1123](https://mypassglobal.atlassian.net/browse/PLAT-1123) | Task | Lon Sendgrid, Konsole and Configcat access - TTB-4309 | **Done** | 2026-01-08 |
| [PLAT-1124](https://mypassglobal.atlassian.net/browse/PLAT-1124) | Task | [API] Rename Sync endpoint items field to profiles | Won't Do | 2026-01-09 |
| [PLAT-1129](https://mypassglobal.atlassian.net/browse/PLAT-1129) | Story | [MyPass] Implement Role Requirement event publisher | Won't Do | 2026-01-14 |
| [PLAT-1136](https://mypassglobal.atlassian.net/browse/PLAT-1136) | Story | [Lambda] Implement Attainment expired event consumer | Won't Do | 2026-01-15 |
| [PLAT-1137](https://mypassglobal.atlassian.net/browse/PLAT-1137) | Task | Grant permissions to Engineering Leads for production incidents | To Do | 2026-01-15 |
| [PLAT-1153](https://mypassglobal.atlassian.net/browse/PLAT-1153) | Task | Add permissions to StagingDeveloper role in AWS | To Do | 2026-01-27 |
| [PLAT-1156](https://mypassglobal.atlassian.net/browse/PLAT-1156) | Task | Upgrade AWS Lambda functions from Node.js 16 runtime | To Do | 2026-01-28 |
| [PLAT-1166](https://mypassglobal.atlassian.net/browse/PLAT-1166) | Task | Quarterly Scheduled Maintenance - February 2025 - MGU Cluster | Blocked | 2026-01-29 |
| [PLAT-1167](https://mypassglobal.atlassian.net/browse/PLAT-1167) | Task | Quarterly Scheduled Maintenance - February 2025 - MGP Cluster | Blocked | 2026-01-29 |
| [PLAT-1168](https://mypassglobal.atlassian.net/browse/PLAT-1168) | Task | Quarterly Scheduled Maintenance - February 2025 - Tools Cluster | Blocked | 2026-01-29 |
| [PLAT-1172](https://mypassglobal.atlassian.net/browse/PLAT-1172) | Task | [API] Return No Content if worker has no current engagements / attainments / assignments | Won't Do | 2026-01-29 |
| [PLAT-1175](https://mypassglobal.atlassian.net/browse/PLAT-1175) | Task | Create automated alert for core Neo4j error logs | To Do | 2026-01-29 |
| [PLAT-1176](https://mypassglobal.atlassian.net/browse/PLAT-1176) | Task | Create Neo4j runbooks | To Do | 2026-01-29 |
| [PLAT-1177](https://mypassglobal.atlassian.net/browse/PLAT-1177) | Task | Create Profile Sync runbooks | To Do | 2026-01-29 |
| [PLAT-1179](https://mypassglobal.atlassian.net/browse/PLAT-1179) | Task | [Lambda] Timestamp checking | **Done** | 2026-02-03 |
| [PLAT-1185](https://mypassglobal.atlassian.net/browse/PLAT-1185) | Task | Position requirements update should trigger assignment recalculation | Won't Do | 2026-02-04 |
| [PLAT-1191](https://mypassglobal.atlassian.net/browse/PLAT-1191) | Task | [Lambda] Refactor services in consumer lambda | **Done** | 2026-02-10 |
| [PLAT-1210](https://mypassglobal.atlassian.net/browse/PLAT-1210) | Task | Remove Unnecessary Modules From WildFly Config | To Do | 2026-02-20 |
| [PLAT-1211](https://mypassglobal.atlassian.net/browse/PLAT-1211) | Task | Build docker compose for local testing | To Do | 2026-02-20 |
| [PLAT-1214](https://mypassglobal.atlassian.net/browse/PLAT-1214) | Task | Custom Domain setup for MyPass website | **Done** | 2026-02-25 |
| [PLAT-1234](https://mypassglobal.atlassian.net/browse/PLAT-1234) | Task | Assistance Needed for DNS Record Update - TTB-4370 | **Done** | 2026-03-15 |
| [PLAT-1247](https://mypassglobal.atlassian.net/browse/PLAT-1247) | Task | End-to-End Pipeline Validation | To Do | 2026-03-19 |
| [PLAT-1248](https://mypassglobal.atlassian.net/browse/PLAT-1248) | Task | Cleanup - Bitbucket and Jenkins | To Do | 2026-03-19 |
| [PLAT-1251](https://mypassglobal.atlassian.net/browse/PLAT-1251) | Task | Dependency Audit - Plugin and Infrastructure Dependencies | To Do | 2026-03-20 |
| [PLAT-1258](https://mypassglobal.atlassian.net/browse/PLAT-1258) | Task | PVT - Multi-thread batch loaders | **Done** | 2026-03-20 |
| [PLAT-1259](https://mypassglobal.atlassian.net/browse/PLAT-1259) | Task | Create Bedrock role for developers in AWS Tools account | To Do | 2026-03-20 |
| [PLAT-1267](https://mypassglobal.atlassian.net/browse/PLAT-1267) | Task | SAML Certificate Rotation for Google Workspace & AWS IAM Identity Center | To Do | 2026-03-23 |
| [PLAT-1273](https://mypassglobal.atlassian.net/browse/PLAT-1273) | Task | Create alert for when Internal Gateway (Kong) is down | To Do | 2026-03-26 |
| [PLAT-1275](https://mypassglobal.atlassian.net/browse/PLAT-1275) | Task | Create baseline integration test for Mutation | To Do | 2026-03-27 |
| [PLAT-1279](https://mypassglobal.atlassian.net/browse/PLAT-1279) | Task | CLONE - Dependency Audit - Neo4j Driver/OGM/Spring Chain | To Do | 2026-03-29 |
| [PLAT-1281](https://mypassglobal.atlassian.net/browse/PLAT-1281) | Task | CLONE - Dependency Audit - Plugin and Infrastructure Dependencies | To Do | 2026-03-29 |
| [PLAT-1282](https://mypassglobal.atlassian.net/browse/PLAT-1282) | Task | Dependency Audit - Neo4j Driver/OGM/Spring Chain (v5) | To Do | 2026-03-29 |
| [PLAT-1283](https://mypassglobal.atlassian.net/browse/PLAT-1283) | Task | Dependency Audit - Plugin and Infrastructure Dependencies (v5) | To Do | 2026-03-29 |
| [PLAT-1284](https://mypassglobal.atlassian.net/browse/PLAT-1284) | Task | CLONE - Dependency Audit - GraphQL Library | To Do | 2026-03-29 |
| [PLAT-1285](https://mypassglobal.atlassian.net/browse/PLAT-1285) | Task | Dependency Audit - GraphQL Library (v5) | To Do | 2026-03-29 |
| [PLAT-1286](https://mypassglobal.atlassian.net/browse/PLAT-1286) | Task | CLONE - Audit Neo4j 4.4 Configuration Changes | To Do | 2026-03-29 |
| [PLAT-1287](https://mypassglobal.atlassian.net/browse/PLAT-1287) | Task | Audit Neo4j 5.x Configuration Changes | To Do | 2026-03-29 |
| [PLAT-1290](https://mypassglobal.atlassian.net/browse/PLAT-1290) | Task | Clean up old equipment infra | To Do | 2026-04-01 |
| [PLAT-1292](https://mypassglobal.atlassian.net/browse/PLAT-1292) | Task | Upgrade Neo4j to 4.4 | To Do | 2026-04-01 |
| [PLAT-1293](https://mypassglobal.atlassian.net/browse/PLAT-1293) | Task | Upgrade Java to v17 | To Do | 2026-04-01 |
| [PLAT-1294](https://mypassglobal.atlassian.net/browse/PLAT-1294) | Task | Upgrade AWS SDK | To Do | 2026-04-01 |
| [PLAT-1295](https://mypassglobal.atlassian.net/browse/PLAT-1295) | Task | Upgrade GraphQL to v8.8 | To Do | 2026-04-01 |
| [PLAT-1296](https://mypassglobal.atlassian.net/browse/PLAT-1296) | Task | Implement Neo4j configuration changes | To Do | 2026-04-01 |
| [PLAT-1297](https://mypassglobal.atlassian.net/browse/PLAT-1297) | Task | Data migration | To Do | 2026-04-01 |
| [PLAT-1302](https://mypassglobal.atlassian.net/browse/PLAT-1302) | Task | Update QA yaml with correct CDN URL | **Done** | 2026-04-02 |
| [PLAT-1304](https://mypassglobal.atlassian.net/browse/PLAT-1304) | Task | Set up DEV2 environment | To Do | 2026-04-02 |
| [PLAT-1305](https://mypassglobal.atlassian.net/browse/PLAT-1305) | Task | Review Claude generated unit tests | To Do | 2026-04-02 |
| [PLAT-1306](https://mypassglobal.atlassian.net/browse/PLAT-1306) | Task | Create tests for E2E gaps | To Do | 2026-04-02 |
| [PLAT-1309](https://mypassglobal.atlassian.net/browse/PLAT-1309) | Task | Validate Requirement For Personal Credentials In AWS | To Do | 2026-04-08 |
| [PLAT-1310](https://mypassglobal.atlassian.net/browse/PLAT-1310) | Task | Splunk Access Request: - TTB-4396 | **Done** | 2026-04-10 |
| [PLAT-1312](https://mypassglobal.atlassian.net/browse/PLAT-1312) | Task | Create alert to monitor reporting queue | To Do | 2026-04-10 |

---

## SPS (16 issues)

| Key | Type | Summary | Status | Created |
|-----|------|---------|--------|---------|
| [SPS-272](https://mypassglobal.atlassian.net/browse/SPS-272) | Bug | The "All" filter does not include expired subcontracts. | Won't Do | 2026-01-05 |
| [SPS-277](https://mypassglobal.atlassian.net/browse/SPS-277) | Task | Display all related resource requests on the supporting document preview pane | Won't Do | 2026-01-07 |
| [SPS-280](https://mypassglobal.atlassian.net/browse/SPS-280) | Task | FE API Integration of subcontracts | **Done** | 2026-01-08 |
| [SPS-282](https://mypassglobal.atlassian.net/browse/SPS-282) | Bug | Workday resolution feature issues | **Done** | 2026-01-08 |
| [SPS-284](https://mypassglobal.atlassian.net/browse/SPS-284) | Task | Testing strategy for supporting documents | Won't Do | 2026-01-09 |
| [SPS-322](https://mypassglobal.atlassian.net/browse/SPS-322) | Task | Initial data load should only create Compliance Scores for entities missing the relationship | Won't Do | 2026-01-22 |
| [SPS-362](https://mypassglobal.atlassian.net/browse/SPS-362) | Task | Wood Australia Active Personnel Count - TTB-4346 | Won't Do | 2026-02-10 |
| [SPS-378](https://mypassglobal.atlassian.net/browse/SPS-378) | Bug | Subcontracts Not Filtered by Asset-Level Permissions | Won't Do | 2026-02-16 |
| [SPS-383](https://mypassglobal.atlassian.net/browse/SPS-383) | Task | Inconsistency identified between the Certificate status displayed in the generated Project Report export from Overview Dashboard. - TTB-4354 | Won't Do | 2026-02-18 |
| [SPS-416](https://mypassglobal.atlassian.net/browse/SPS-416) | Task | Deploy Storybook to nonprod environment | To Do | 2026-03-13 |
| [SPS-419](https://mypassglobal.atlassian.net/browse/SPS-419) | Task | Remove rt_enable_compliance_percentage_api feature flag | To Do | 2026-03-16 |
| [SPS-423](https://mypassglobal.atlassian.net/browse/SPS-423) | Task | BP-Owned-Verifications report in Konsole has no data - TTB-4374 | Won't Do | 2026-03-18 |
| [SPS-443](https://mypassglobal.atlassian.net/browse/SPS-443) | Bug | Duplicate bookings cannot be deleted via the Business Partner Booking API | To Do | 2026-03-27 |
| [SPS-448](https://mypassglobal.atlassian.net/browse/SPS-448) | Bug | Subcontracts tab should not appear in sidebar view | To Do | 2026-03-30 |
| [SPS-451](https://mypassglobal.atlassian.net/browse/SPS-451) | Task | Modification to the Worker Breakdown Report - TTB-4383 | To Do | 2026-03-31 |
| [SPS-466](https://mypassglobal.atlassian.net/browse/SPS-466) | Story | Amplitude: Instrument shortlisted personnel and followed up invite events | To Do | 2026-04-07 |

---

## Issues requiring investigation (Done with no workflow evidence)

These 15 issues reached a terminal Done/Released status with no recorded in-progress transition. They may indicate work completed directly in production, issues resolved without updating Jira, or workflow automation that bypassed status transitions.

| Board | Key | Summary | Created |
|-------|-----|---------|---------|
| BPT | [BPT-90](https://mypassglobal.atlassian.net/browse/BPT-90) | BP with restricted billing disabled has access to portal with no active subscription | 2026-03-19 |
| BPT | [BPT-133](https://mypassglobal.atlassian.net/browse/BPT-133) | Update Upgrade Prompt 'Manage Button' so it takes the user to the billing & subscription screen | 2026-03-27 |
| OCS | [OCS-976](https://mypassglobal.atlassian.net/browse/OCS-976) | Fix failed contract automation scripts | 2026-03-06 |
| PLAT | [PLAT-1121](https://mypassglobal.atlassian.net/browse/PLAT-1121) | Happy Sheen Sendgrid, Konsole and Configcat access - TTB-4310 | 2026-01-08 |
| PLAT | [PLAT-1122](https://mypassglobal.atlassian.net/browse/PLAT-1122) | Aldene Sendgrid, Konsole and Configcat access - TTB-4308 | 2026-01-08 |
| PLAT | [PLAT-1123](https://mypassglobal.atlassian.net/browse/PLAT-1123) | Lon Sendgrid, Konsole and Configcat access - TTB-4309 | 2026-01-08 |
| PLAT | [PLAT-1179](https://mypassglobal.atlassian.net/browse/PLAT-1179) | [Lambda] Timestamp checking | 2026-02-03 |
| PLAT | [PLAT-1191](https://mypassglobal.atlassian.net/browse/PLAT-1191) | [Lambda] Refactor services in consumer lambda | 2026-02-10 |
| PLAT | [PLAT-1214](https://mypassglobal.atlassian.net/browse/PLAT-1214) | Custom Domain setup for MyPass website | 2026-02-25 |
| PLAT | [PLAT-1234](https://mypassglobal.atlassian.net/browse/PLAT-1234) | Assistance Needed for DNS Record Update - TTB-4370 | 2026-03-15 |
| PLAT | [PLAT-1258](https://mypassglobal.atlassian.net/browse/PLAT-1258) | PVT - Multi-thread batch loaders | 2026-03-20 |
| PLAT | [PLAT-1302](https://mypassglobal.atlassian.net/browse/PLAT-1302) | Update QA yaml with correct CDN URL | 2026-04-02 |
| PLAT | [PLAT-1310](https://mypassglobal.atlassian.net/browse/PLAT-1310) | Splunk Access Request: - TTB-4396 | 2026-04-10 |
| SPS | [SPS-280](https://mypassglobal.atlassian.net/browse/SPS-280) | FE API Integration of subcontracts | 2026-01-08 |
| SPS | [SPS-282](https://mypassglobal.atlassian.net/browse/SPS-282) | Workday resolution feature issues | 2026-01-08 |
