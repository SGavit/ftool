(() => {
    'use strict';

    // Chrome-extension replacement for Tampermonkey GM storage.
    const GM_setValue = (key, value) => chrome.storage.local.set({ [key]: value });
    const GM_addValueChangeListener = (key, callback) => {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes[key]) return;
            callback(key, changes[key].oldValue, changes[key].newValue, false);
        });
    };

    // ------------------------------------------------------------
    // SCRIPT 1: SHIPMENT WORKFLOW BRIDGE (original logic preserved)
    // ------------------------------------------------------------

    const SOURCE_HOSTS = [];
    const TARGET_HOSTS = [];

    const PAYLOAD_KEY = 'shipmentWorkflowBridge_payload_v1';
    const ACK_KEY = 'shipmentWorkflowBridge_ack_v1';
    const MESSAGE_TTL_MS = 5 * 60 * 1000;

    const LEGACY_PANEL_IDS = [
        'stc-floating-panel',
        'stc-floating-toggle',
        'quick-status-panel',
        'amountFillerPanel'
    ];

    let currentTransferId = null;
    let transferInProgress = false;
    let transferGuardTimer = null;
    let targetProcessing = Promise.resolve();

    function hostAllowed(allowList) {
        return allowList.length === 0 || allowList.includes(location.hostname);
    }

    function getText(element) {
        return (element?.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeStatus(value) {
        return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[_\s]+/g, ' ')
            .trim()
            .toUpperCase();
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitFor(getter, timeoutMs = 5000, intervalMs = 100) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const result = getter();
            if (result) return result;
            await sleep(intervalMs);
        }
        return null;
    }

    function createId() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function parseAmount(rawValue) {
        let raw = String(rawValue || '').trim();
        if (!raw || raw === '—' || raw === '-') return null;
        const isParenthesizedNegative = /^\s*\(.*\)\s*$/.test(raw);
        let value = raw.replace(/[^0-9,.-]/g, '');
        value = value.replace(/,/g, '');
        if (isParenthesizedNegative) value = `-${value.replace(/^-/, '')}`;
        if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return null;
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        return String(number);
    }

    function isSourcePage() {
        return hostAllowed(SOURCE_HOSTS) && Boolean(
            document.querySelector('select[name="worder.status"]') &&
            document.querySelector('#event tbody tr') &&
            document.querySelector('#applicablecharges')
        );
    }

    function findPrimeDropdown(fieldLabel) {
        const dropdowns = [...document.querySelectorAll('.p-dropdown')];
        return dropdowns.find(dropdown => {
            const combo = dropdown.querySelector('[role="combobox"][aria-label]');
            return combo?.getAttribute('aria-label') === fieldLabel;
        }) || null;
    }

    function isTargetPage() {
        return hostAllowed(TARGET_HOSTS) && Boolean(
            findPrimeDropdown('Status Comment') &&
            findPrimeDropdown('Carrier Status')
        );
    }

    function getDropdownStatus() {
        const select = document.querySelector('select[name="worder.status"]');
        if (!select) return '';
        const option = select.options[select.selectedIndex];
        return normalizeStatus(option ? option.textContent : select.value);
    }

    function getLatestCommentStatus() {
        const firstRow = document.querySelector('#event tbody tr');
        if (!firstRow) return '';
        const cells = firstRow.querySelectorAll('td');
        return cells.length >= 3 ? normalizeStatus(getText(cells[2])) : '';
    }

    function getStatusCommentOption() {
        const dropdownStatus = getDropdownStatus();
        const commentStatus = getLatestCommentStatus();

        if (dropdownStatus === 'PREVIOUSLY INVOICED' && commentStatus === 'READY TO INVOICE') {
            return 'Auto PI on RTI';
        }
        if (dropdownStatus === 'READY TO INVOICE' && commentStatus === 'READY TO INVOICE') {
            return 'Ready To Invoice';
        }
        if (dropdownStatus === 'PREVIOUSLY INVOICED' && commentStatus === 'PREVIOUSLY INVOICED') {
            return 'Previously Invoiced';
        }
        return null;
    }

    function getTotals() {
        const table = document.querySelector('#applicablecharges');
        if (!table) return null;
        for (const row of table.querySelectorAll('tr')) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 3) continue;
            const firstCell = getText(cells[0]).replace(/:$/, '').trim().toLowerCase();
            if (firstCell === 'total') {
                return { chargeText: getText(cells[1]), costText: getText(cells[2]) };
            }
        }
        return null;
    }

    function readShipmentData() {
        const totals = getTotals();
        if (!totals) throw new Error('Could not find the Total row in Applicable Charges.');
        const totalCharge = parseAmount(totals.chargeText);
        const totalCost = parseAmount(totals.costText);
        if (totalCharge === null || totalCost === null) {
            throw new Error('Total Charge or Total Cost is missing or is not a valid amount.');
        }
        return { statusComment: getStatusCommentOption(), totalCharge, totalCost };
    }

    function isProtectedFocus(element) {
        if (!(element instanceof HTMLElement)) return false;
        return Boolean(element.isContentEditable || element.closest(
            'input, textarea, select, button, a, [contenteditable="true"], [role="textbox"], [role="button"], [role="menuitem"]'
        ));
    }

    function showAckOnSource(ack) {
        if (!ack || ack.id !== currentTransferId) return;
        clearTimeout(transferGuardTimer);
        transferInProgress = false;
        if (ack.success) {
            console.info('[Shipment Workflow Bridge] Domain B updated successfully.', ack);
        } else {
            console.warn('[Shipment Workflow Bridge] Domain B reported an issue.', ack);
        }
    }

    async function sendShipmentData() {
        if (!isSourcePage() || transferInProgress) return;
        transferInProgress = true;
        let shipment;
        try {
            shipment = readShipmentData();
        } catch (error) {
            transferInProgress = false;
            console.warn('[Shipment Workflow Bridge] Could not read shipment data:', error.message || error);
            return;
        }

        const payload = {
            id: createId(),
            sentAt: Date.now(),
            sourceOrigin: location.origin,
            statusComment: shipment.statusComment,
            totalCharge: shipment.totalCharge,
            totalCost: shipment.totalCost
        };
        currentTransferId = payload.id;
        clearTimeout(transferGuardTimer);
        transferGuardTimer = setTimeout(() => {
            if (currentTransferId === payload.id) {
                transferInProgress = false;
                console.warn('[Shipment Workflow Bridge] No acknowledgement received from Domain B.');
            }
        }, 10000);

        try {
            await GM_setValue(PAYLOAD_KEY, payload);
            console.info('[Shipment Workflow Bridge] Shipment data sent to Domain B.', {
                statusComment: payload.statusComment || 'No matching condition',
                totalCharge: payload.totalCharge,
                totalCost: payload.totalCost
            });
        } catch (error) {
            clearTimeout(transferGuardTimer);
            transferInProgress = false;
            console.error('[Shipment Workflow Bridge] Transfer failed:', error);
        }
    }

    function handleShortcut(event) {
        const isNumpadEnter = event.code === 'NumpadEnter' ||
            (event.key === 'Enter' && event.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD);
        if (!isNumpadEnter || event.repeat || !isSourcePage()) return;
        if (isProtectedFocus(event.target) || isProtectedFocus(document.activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        void sendShipmentData();
    }

    document.addEventListener('keydown', handleShortcut, true);

    function isDisabledOption(option) {
        return option.getAttribute('data-p-disabled') === 'true' ||
            option.getAttribute('aria-disabled') === 'true' ||
            option.classList.contains('p-disabled');
    }

    async function selectPrimeDropdown(fieldLabel, wantedText) {
        const dropdown = await waitFor(() => findPrimeDropdown(fieldLabel), 6000);
        if (!dropdown) return { ok: false, message: `${fieldLabel} dropdown was not found.` };
        const combo = dropdown.querySelector('[role="combobox"][aria-label]');
        if (!combo) return { ok: false, message: `${fieldLabel} control was not found.` };
        const currentText = getText(dropdown.querySelector('.p-dropdown-label') || combo);
        if (normalizeStatus(currentText) === normalizeStatus(wantedText)) {
            return { ok: true, message: 'Already selected.' };
        }
        if (combo.getAttribute('aria-expanded') !== 'true') combo.click();
        const option = await waitFor(() => [...document.querySelectorAll('.p-dropdown-items .p-dropdown-item')]
            .find(item => normalizeStatus(getText(item)) === normalizeStatus(wantedText) && !isDisabledOption(item)), 5000);
        if (!option) return { ok: false, message: `Option "${wantedText}" was not found in ${fieldLabel}.` };
        option.click();
        await sleep(180);
        return { ok: true, message: 'Selected.' };
    }

    function setInputValue(input, value) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (!descriptor?.set) throw new Error('Could not access the input value setter.');
        descriptor.set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function fillAmount(placeholder, value) {
        const matchingInputs = await waitFor(() => {
            const inputs = [...document.querySelectorAll('input')].filter(input =>
                (input.getAttribute('placeholder') || '').trim().toLowerCase() === placeholder.toLowerCase()
            );
            return inputs.length ? inputs : null;
        }, 6000);
        if (!matchingInputs) return { ok: false, message: `${placeholder} input was not found.` };
        let count = 0;
        for (const input of matchingInputs) {
            if (input.disabled || input.readOnly) continue;
            setInputValue(input, value);
            count++;
        }
        return count
            ? { ok: true, message: `Filled ${count} field(s).` }
            : { ok: false, message: `${placeholder} field is disabled or read-only.` };
    }

    async function applyPayload(payload) {
        if (!isTargetPage()) return;
        if (!payload || !payload.id || !payload.sentAt) return;
        if (Date.now() - payload.sentAt > MESSAGE_TTL_MS) {
            console.warn('[Shipment Workflow Bridge] Ignored expired transfer.');
            return;
        }

        const result = {
            id: payload.id,
            success: true,
            statusComment: 'Skipped (no matching condition)',
            carrierStatus: 'Not attempted',
            billedAmount: 'Not attempted',
            payAmount: 'Not attempted'
        };

        try {
            if (payload.statusComment) {
                const statusResult = await selectPrimeDropdown('Status Comment', payload.statusComment);
                result.statusComment = statusResult.message;
                if (!statusResult.ok) result.success = false;
            }
            const carrierResult = await selectPrimeDropdown('Carrier Status', 'Delivered');
            result.carrierStatus = carrierResult.message;
            if (!carrierResult.ok) result.success = false;

            const isPreviouslyInvoiced = normalizeStatus(payload.statusComment) === 'PREVIOUSLY INVOICED';
            const billedAmount = isPreviouslyInvoiced ? '0' : payload.totalCharge;
            const payAmount = isPreviouslyInvoiced ? '0' : payload.totalCost;

            const billedResult = await fillAmount('Billed Amount', billedAmount);
            result.billedAmount = billedResult.message;
            if (!billedResult.ok) result.success = false;
            const payResult = await fillAmount('Pay Amount', payAmount);
            result.payAmount = payResult.message;
            if (!payResult.ok) result.success = false;
        } catch (error) {
            result.success = false;
            result.error = error.message || String(error);
            console.error('[Shipment Workflow Bridge] Apply failed:', error);
        }

        console.info('[Shipment Workflow Bridge] Transfer result:', result);
        try {
            await GM_setValue(ACK_KEY, result);
        } catch (error) {
            console.warn('[Shipment Workflow Bridge] Could not send acknowledgement:', error);
        }
    }

    GM_addValueChangeListener(PAYLOAD_KEY, (_key, _oldValue, newValue) => {
        if (!newValue || !isTargetPage()) return;
        targetProcessing = targetProcessing
            .then(() => applyPayload(newValue))
            .catch(error => console.error('[Shipment Workflow Bridge] Target processing error:', error));
    });

    GM_addValueChangeListener(ACK_KEY, (_key, _oldValue, newValue) => {
        if (isSourcePage()) showAckOnSource(newValue);
    });

    function removeLegacyPanels() {
        for (const id of LEGACY_PANEL_IDS) document.getElementById(id)?.remove();
    }

    function initialize() {
        if (!document.body) return;
        removeLegacyPanels();
        const observer = new MutationObserver(() => removeLegacyPanels());
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    initialize();

    // ------------------------------------------------------------
    // SCRIPT 2: HOVER SEARCH / CLICK OPEN WORK ORDER TAB (original logic preserved)
    // ------------------------------------------------------------

    const TAB_NAME = 'fcadmin_workorder_tab';
    const BASE_URL = 'https://fcadmin.freightcom.com/workorder/WorkOrderManager.do?method=view&id=';
    let lastOpenedNumber = '';

    function getWorkOrderInput() {
        const labels = document.querySelectorAll('.col-md-5.mt-2');
        for (const label of labels) {
            if (label.textContent.trim() !== 'Work Order') continue;
            const input = label.parentElement?.querySelector('input[readonly]');
            if (input && /^\d{6,}$/.test(input.value.trim())) return input;
        }
        return null;
    }

    document.addEventListener('click', function (event) {
        const input = getWorkOrderInput();
        if (!input || event.target !== input) return;
        const id = input.value.trim();
        if (!/^\d{6,}$/.test(id)) return;
        if (id === lastOpenedNumber) return;
        lastOpenedNumber = id;
        const url = `${BASE_URL}${encodeURIComponent(id)}&edit=true`;
        const tab = window.open(url, TAB_NAME);
        if (!tab) lastOpenedNumber = '';
    }, true);
})();
