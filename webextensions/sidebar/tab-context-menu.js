/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

/*
 Workaround until native context menu becomes available.
 I have very less motivation to maintain this for future versions.
 See also: https://bugzilla.mozilla.org/show_bug.cgi?id=1376251
           https://bugzilla.mozilla.org/show_bug.cgi?id=1396031
*/
import MenuUI from '/extlib/MenuUI.js';

import {
  log as internalLogger,
  wait,
  notify,
  configs
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Tabs from '/common/tabs.js';
import * as TabsOpen from '/common/tabs-open.js';
import * as Tree from '/common/tree.js';
import * as Bookmark from '/common/bookmark.js';
import * as TSTAPI from '/common/tst-api.js';
import * as EventUtils from './event-utils.js';

import EventListenerManager from '/extlib/EventListenerManager.js';

function log(...args) {
  internalLogger('sidebar/tab-context-menu', ...args);
}

export const onTabsClosing = new EventListenerManager();

let mUI;
let mMenu;

let mContextTab      = null;
let mLastOpenOptions = null;
let mContextWindowId = null;
let mLastContextualIdentity = null;
let mLastMultiselected = false;
let mIsDirty         = false;

const mExtraItems = new Map();

export function init() {
  mMenu = document.querySelector('#tabContextMenu');
  document.addEventListener('contextmenu', onContextMenu, { capture: true });

  mUI = new MenuUI({
    root: mMenu,
    onCommand,
    //onShown,
    onHidden,
    appearance:        'menu',
    animationDuration: configs.animation ? configs.collapseDuration : 0.001,
    subMenuOpenDelay:  configs.subMenuOpenDelay,
    subMenuCloseDelay: configs.subMenuCloseDelay
  });

  browser.runtime.onMessage.addListener(onMessage);
  browser.runtime.onMessageExternal.addListener(onExternalMessage);

  browser.runtime.sendMessage({
    type: TSTAPI.kCONTEXT_MENU_GET_ITEMS
  }).then(aItems => {
    importExtraItems(aItems);
    mIsDirty = true;
  });
}

async function rebuild() {
  if (!mIsDirty)
    return;

  mIsDirty = false;

  const firstExtraItem = mMenu.querySelector('.extra');
  if (firstExtraItem) {
    const range = document.createRange();
    range.selectNodeContents(mMenu);
    range.setStartBefore(firstExtraItem);
    range.deleteContents();
    range.detach();
  }

  if (mExtraItems.size == 0)
    return;

  updateMultiselectedLabel();
  updateContextualIdentitiesSelector();

  const extraItemNodes = document.createDocumentFragment();
  for (const [id, extraItems] of mExtraItems.entries()) {
    let addonItem = document.createElement('li');
    const name = getAddonName(id);
    addonItem.appendChild(document.createTextNode(name));
    addonItem.setAttribute('title', name);
    addonItem.classList.add('extra');
    const icon = getAddonIcon(id);
    if (icon)
      addonItem.dataset.icon = icon;
    prepareAsSubmenu(addonItem);

    const toBeBuiltItems = [];
    for (const item of extraItems) {
      if (item.contexts && !item.contexts.includes('tab'))
        continue;
      if (mContextTab &&
          item.documentUrlPatterns &&
          !matchesToCurrentTab(item.documentUrlPatterns))
        continue;
      toBeBuiltItems.push(item);
    }
    const topLevelItems = toBeBuiltItems.filter(item => !item.parentId);
    if (topLevelItems.length == 1 &&
        !topLevelItems[0].icons)
      topLevelItems[0].icons = TSTAPI.getAddon(id).icons || {};

    const addonSubMenu = addonItem.lastChild;
    const knownItems   = {};
    for (const item of toBeBuiltItems) {
      const itemNode = buildExtraItem(item, id);
      if (item.parentId && item.parentId in knownItems) {
        const parent = knownItems[item.parentId];
        prepareAsSubmenu(parent);
        parent.lastChild.appendChild(itemNode);
      }
      else {
        addonSubMenu.appendChild(itemNode);
      }
      knownItems[item.id] = itemNode;
    }
    switch (addonSubMenu.childNodes.length) {
      case 0:
        break;
      case 1:
        addonItem = addonSubMenu.removeChild(addonSubMenu.firstChild);
        extraItemNodes.appendChild(addonItem);
      default:
        extraItemNodes.appendChild(addonItem);
        break;
    }
  }
  if (!extraItemNodes.hasChildNodes())
    return;

  const separator = document.createElement('li');
  separator.classList.add('extra');
  separator.classList.add('separator');
  extraItemNodes.insertBefore(separator, extraItemNodes.firstChild);
  mMenu.appendChild(extraItemNodes);
}

function updateMultiselectedLabel() {
  const isMultiselected = Tabs.isMultiselected(Tabs.getTabById(mContextTab));
  const activeLabelAttribute = isMultiselected ? 'data-label-multiselected' : 'data-label-single' ;
  const labelRange = document.createRange();
  for (const item of mMenu.querySelectorAll(`[${activeLabelAttribute}]`)) {
    const label = item.getAttribute(activeLabelAttribute);
    item.setAttribute('title', label);
    labelRange.selectNodeContents(item);
    labelRange.deleteContents();
    labelRange.insertNode(document.createTextNode(label));
  }
  labelRange.detach();
  mLastMultiselected = isMultiselected;
}

function updateContextualIdentitiesSelector() {
  if (!mContextTab)
    return;
  const isDefault    = mContextTab.cookieStoreId == 'firefox-default';
  const container    = document.getElementById(Constants.kCONTEXTUAL_IDENTITY_SELECTOR_CONTEXT_MENU);
  const defaultItems = container.querySelectorAll('.contextual-identity-default');
  const identities   = container.querySelectorAll('[data-value]:not(.contextual-identity-default)');
  if (isDefault) {
    for (const item of defaultItems) {
      item.style.display = 'none';
    }
    for (const item of identities) {
      item.style.display = '';
    }
  }
  else {
    for (const item of defaultItems) {
      item.style.display = '';
    }
    for (const item of identities) {
      item.style.display = item.dataset.value == mContextTab.cookieStoreId ? 'none' : '' ;
    }
  }
  mLastContextualIdentity = mContextTab.cookieStoreId;
}

function getAddonName(id) {
  if (id == browser.runtime.id)
    return browser.i18n.getMessage('extensionName');
  const addon = TSTAPI.getAddon(id) || {};
  return addon.name || id.replace(/@.+$/, '');
}

function getAddonIcon(id) {
  const addon = TSTAPI.getAddon(id) || {};
  return chooseIconForAddon({
    id:         id,
    internalId: addon.internalId,
    icons:      addon.icons || {}
  });
}

function chooseIconForAddon(params) {
  const icons = params.icons || {};
  const addon = TSTAPI.getAddon(params.id) || {};
  let sizes = Object.keys(icons).map(aSize => parseInt(aSize)).sort();
  const reducedSizes = sizes.filter(aSize => aSize < 16);
  if (reducedSizes.length > 0)
    sizes = reducedSizes;
  const size = sizes[0] || null;
  if (!size)
    return null;
  let url = icons[size];
  if (!/^\w+:\/\//.test(url))
    url = `moz-extension://${addon.internalId || params.internalId}/${url.replace(/^\//, '')}`;
  return url;
}

function prepareAsSubmenu(aItemNode) {
  if (aItemNode.querySelector('ul'))
    return aItemNode;
  aItemNode.appendChild(document.createElement('ul'));
  return aItemNode;
}

function buildExtraItem(item, aOwnerAddonId) {
  const itemNode = document.createElement('li');
  itemNode.setAttribute('id', `${aOwnerAddonId}-${item.id}`);
  itemNode.setAttribute('data-item-id', item.id);
  itemNode.setAttribute('data-item-owner-id', aOwnerAddonId);
  itemNode.classList.add('extra');
  itemNode.classList.add(item.type || 'normal');
  if (item.type == 'checkbox' || item.type == 'radio') {
    if (item.checked)
      itemNode.classList.add('checked');
  }
  if (item.type != 'separator') {
    itemNode.appendChild(document.createTextNode(item.title));
    itemNode.setAttribute('title', item.title);
  }
  if (item.enabled === false)
    itemNode.classList.add('disabled');
  else
    itemNode.classList.remove('disabled');;
  const addon = TSTAPI.getAddon(aOwnerAddonId) || {};
  const icon = chooseIconForAddon({
    id:         aOwnerAddonId,
    internalId: addon.internalId,
    icons:      item.icons || {}
  });
  if (icon)
    itemNode.dataset.icon = icon;
  return itemNode;
}

function matchesToCurrentTab(aPatterns) {
  if (!Array.isArray(aPatterns))
    aPatterns = [aPatterns];
  for (const pattern of aPatterns) {
    if (matchPatternToRegExp(pattern).test(mContextTab.url))
      return true;
  }
  return false;
}
// https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Match_patterns
const matchPattern = /^(?:(\*|http|https|file|ftp|app):\/\/([^\/]+|)\/?(.*))$/i;
function matchPatternToRegExp(aPattern) {
  if (aPattern === '<all_urls>')
    return (/^(?:https?|file|ftp|app):\/\//);
  const match = matchPattern.exec(aPattern);
  if (!match)
    throw new TypeError(`"${aPattern}" is not a valid MatchPattern`);

  const [, scheme, host, path,] = match;
  return new RegExp('^(?:'
                    + (scheme === '*' ? 'https?' : escape(scheme)) + ':\\/\\/'
                    + (host === '*' ? '[^\\/]*' : escape(host).replace(/^\*\./g, '(?:[^\\/]+)?'))
                    + (path ? (path == '*' ? '(?:\\/.*)?' : ('\\/' + escape(path).replace(/\*/g, '.*'))) : '\\/?')
                    + ')$');
}

export async function open(options = {}) {
  await close();
  mLastOpenOptions = options;
  mContextTab      = options.tab;
  mContextWindowId = options.windowId || (mContextTab && mContextTab.windowId);
  if (mContextTab && mLastContextualIdentity != mContextTab.cookieStoreId)
    mIsDirty = true;
  if (mLastMultiselected != Tabs.isMultiselected(Tabs.getTabById(mContextTab)))
    mIsDirty = true;
  await rebuild();
  if (mIsDirty) {
    return await open(options);
  }
  applyContext();
  const originalCanceller = options.canceller;
  options.canceller = () => {
    return (typeof originalCanceller == 'function' && originalCanceller()) || mIsDirty;
  };
  await mUI.open(options);
  if (mIsDirty) {
    return await open(options);
  }
}

export async function close() {
  await mUI.close();
  mMenu.removeAttribute('data-tab-id');
  mMenu.removeAttribute('data-tab-states');
  mContextTab      = null;
  mContextWindowId = null;
  mLastOpenOptions = null;
}

function applyContext() {
  if (mContextTab) {
    mMenu.setAttribute('data-tab-id', mContextTab.id);
    const states = [];
    if (mContextTab.active)
      states.push('active');
    if (mContextTab.pinned)
      states.push('pinned');
    if (mContextTab.audible)
      states.push('audible');
    if (mContextTab.mutedInfo && mContextTab.mutedInfo.muted)
      states.push('muted');
    if (mContextTab.discarded)
      states.push('discarded');
    if (mContextTab.incognito)
      states.push('incognito');
    if (Tabs.isMultiselected(Tabs.getTabById(mContextTab)))
      states.push('multiselected');
    mMenu.setAttribute('data-tab-states', states.join(' '));
  }

  if (Tabs.getTabs().length > 1)
    mMenu.classList.add('has-multiple-tabs');
  else
    mMenu.classList.remove('has-multiple-tabs');

  switch (Tabs.getNormalTabs().length) {
    case 0:
      mMenu.classList.remove('has-normal-tabs');
      mMenu.classList.remove('has-multiple-normal-tabs');
      break;
    case 1:
      mMenu.classList.add('has-normal-tabs');
      mMenu.classList.remove('has-multiple-normal-tabs');
      break;
    default:
      mMenu.classList.add('has-normal-tabs');
      mMenu.classList.add('has-multiple-normal-tabs');
      break;
  }
}

async function onCommand(item, event) {
  if (event.button == 1)
    return;

  const contextTab = mContextTab;
  const contextWindowId = mContextWindowId;
  wait(0).then(() => close()); // close the menu immediately!

  const isMultiselected   = Tabs.isMultiselected(Tabs.getTabById(contextTab));
  const multiselectedTabs = isMultiselected && Tabs.getSelectedTabs();

  switch (item.id) {
    case 'context_reloadTab':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.reload(tab.apiTab.id);
        }
      }
      else {
        browser.tabs.reload(contextTab.id);
      }
      break;
    case 'context_toggleMuteTab-mute':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.update(tab.apiTab.id, { muted: true });
        }
      }
      else {
        browser.tabs.update(contextTab.id, { muted: true });
      }
      break;
    case 'context_toggleMuteTab-unmute':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.update(tab.apiTab.id, { muted: false });
        }
      }
      else {
        browser.tabs.update(contextTab.id, { muted: false });
      }
      break;
    case 'context_pinTab':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.update(tab.apiTab.id, { pinned: true });
        }
      }
      else {
        browser.tabs.update(contextTab.id, { pinned: true });
      }
      break;
    case 'context_unpinTab':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.update(tab.apiTab.id, { pinned: false });
        }
      }
      else {
        browser.tabs.update(contextTab.id, { pinned: false });
      }
      break;
    case 'context_duplicateTab':
      /*
        Due to difference between Firefox's "duplicate tab" implementation,
        TST sometimes fails to detect duplicated tabs based on its
        session information. Thus we need to duplicate as an internally
        duplicated tab. For more details, see also:
        https://github.com/piroor/treestyletab/issues/1437#issuecomment-334952194
      */
      // browser.tabs.duplicate(contextTab.id);
      return (async () => {
        const sourceTab = Tabs.getTabById(contextTab);
        log('source tab: ', sourceTab, !!sourceTab.apiTab);
        const duplicatedTabs = await Tree.moveTabs([sourceTab], {
          duplicate:           true,
          destinationWindowId: contextWindowId,
          insertAfter:         sourceTab,
          inRemote:            true
        });
        Tree.behaveAutoAttachedTab(duplicatedTabs[0], {
          baseTab:  sourceTab,
          behavior: configs.autoAttachOnDuplicated,
          inRemote: true
        });
      })();
    case 'context_openTabInWindow':
      if (multiselectedTabs) {
        Tree.openNewWindowFromTabs(multiselectedTabs, {
          inRemote:  true
        });
      }
      else {
        await browser.windows.create({
          tabId:     contextTab.id,
          incognito: contextTab.incognito
        });
      }
      break;
    case 'context_reloadAllTabs': {
      const apiTabs = await browser.tabs.query({ windowId: contextWindowId });
      for (const apiTab of apiTabs) {
        browser.tabs.reload(apiTab.id);
      }
    }; break;
    case 'context_bookmarkAllTabs': {
      const apiTabs = multiselectedTabs ?
        multiselectedTabs.map(tab => tab.apiTab) :
        await browser.tabs.query({ windowId: contextWindowId }) ;
      const folder = await Bookmark.bookmarkTabs(apiTabs.map(Tabs.getTabById));
      if (folder)
        browser.bookmarks.get(folder.parentId).then(folders => {
          notify({
            title:   browser.i18n.getMessage('bookmarkTabs_notification_success_title'),
            message: browser.i18n.getMessage('bookmarkTabs_notification_success_message', [
              apiTabs[0].title,
              apiTabs.length,
              folders[0].title
            ]),
            icon:    Constants.kNOTIFICATION_DEFAULT_ICON
          });
        });
    }; break;
    case 'context_closeTabsToTheEnd': {
      const apiTabs = await browser.tabs.query({ windowId: contextWindowId });
      let after = false;
      const closeAPITabs = [];
      const keptTabIds = multiselectedTabs ?
        multiselectedTabs.map(tab => tab.apiTab.id) :
        [contextTab.id] ;
      for (const apiTab of apiTabs) {
        if (keptTabIds.includes(apiTab.id)) {
          after = true;
          continue;
        }
        if (after && !apiTab.pinned)
          closeAPITabs.push(apiTab);
      }
      const canceled = (await onTabsClosing.dispatch(closeAPITabs.length, { windowId: contextWindowId })) === false;
      if (canceled)
        return;
      browser.tabs.remove(closeAPITabs.map(aPITab => aPITab.id));
    }; break;
    case 'context_closeOtherTabs': {
      const apiTabs  = await browser.tabs.query({ windowId: contextWindowId });
      const keptTabIds = multiselectedTabs ?
        multiselectedTabs.map(tab => tab.apiTab.id) :
        [contextTab.id] ;
      const closeAPITabs = apiTabs.filter(aPITab => !aPITab.pinned && !keptTabIds.includes(aPITab.id)).map(aPITab => aPITab.id);
      const canceled = (await onTabsClosing.dispatch(closeAPITabs.length, { windowId: contextWindowId })) === false;
      if (canceled)
        return;
      browser.tabs.remove(closeAPITabs);
    }; break;
    case 'context_undoCloseTab': {
      const sessions = await browser.sessions.getRecentlyClosed({ maxResults: 1 });
      if (sessions.length && sessions[0].tab)
        browser.sessions.restore(sessions[0].tab.sessionId);
    }; break;
    case 'context_closeTab':
      if (multiselectedTabs) {
        // close down to top, to keep tree structure of Tree Style Tab
        multiselectedTabs.reverse();
        for (const tab of multiselectedTabs) {
          browser.tabs.remove(tab.apiTab.id);
        }
      }
      else {
        browser.tabs.remove(contextTab.id);
      }
      break;

    default: {
      const contextualIdentityMatch = item.id.match(/^context_reopenInContainer:(.+)$/);
      if (contextTab &&
          contextualIdentityMatch) {
        // Open in Container
        const contextTabElement = Tabs.getTabById(contextTab);
        const tab = await TabsOpen.openURIInTab(contextTab.url, {
          windowId:      contextTab.windowId,
          cookieStoreId: contextualIdentityMatch[1]
        });
        Tree.behaveAutoAttachedTab(tab, {
          baseTab:  contextTabElement,
          behavior: configs.autoAttachOnDuplicated,
          inRemote: true
        });
        break;
      }
      const id = item.getAttribute('data-item-id');
      if (id) {
        const modifiers = [];
        if (event.metaKey)
          modifiers.push('Command');
        if (event.ctrlKey) {
          modifiers.push('Ctrl');
          if (/^Mac/i.test(navigator.platform))
            modifiers.push('MacCtrl');
        }
        if (event.shiftKey)
          modifiers.push('Shift');
        const checked    = item.matches('.radio, .checkbox:not(.checked)');
        const wasChecked = item.matches('.radio.checked, .checkbox.checked');
        const message = {
          type: TSTAPI.kCONTEXT_MENU_CLICK,
          info: {
            checked,
            editable:         false,
            frameUrl:         null,
            linkUrl:          null,
            mediaType:        null,
            menuItemId:       id,
            modifiers:        modifiers,
            pageUrl:          null,
            parentMenuItemId: null,
            selectionText:    null,
            srcUrl:           null,
            wasChecked
          },
          tab: contextTab || null
        };
        const owner = item.getAttribute('data-item-owner-id');
        if (owner == browser.runtime.id)
          await browser.runtime.sendMessage(message);
        else
          await browser.runtime.sendMessage(owner, message);

        if (item.matches('.checkbox')) {
          item.classList.toggle('checked');
          for (const itemData of mExtraItems.get(item.dataset.itemOwnerId)) {
            if (itemData.id != item.dataset.itemId)
              continue;
            itemData.checked = item.matches('.checked');
            browser.runtime.sendMessage({
              type:    TSTAPI.kCONTEXT_ITEM_CHECKED_STATUS_CHANGED,
              id:      item.dataset.itemId,
              ownerId: item.dataset.itemOwnerId,
              checked: itemData.checked
            });
            break;
          }
          mIsDirty = true;
        }
        else if (item.matches('.radio')) {
          const currentRadioItems = new Set();
          let radioItems = null;
          for (const itemData of mExtraItems.get(item.dataset.itemOwnerId)) {
            if (itemData.type == 'radio') {
              currentRadioItems.add(itemData);
            }
            else if (radioItems == currentRadioItems) {
              break;
            }
            else {
              currentRadioItems.clear();
            }
            if (itemData.id == item.dataset.itemId)
              radioItems = currentRadioItems;
          }
          if (radioItems) {
            for (const itemData of radioItems) {
              itemData.checked = itemData.id == item.dataset.itemId;
              const radioItem = document.getElementById(`${item.dataset.itemOwnerId}-${itemData.id}`);
              if (radioItem) {
                if (itemData.checked)
                  radioItem.classList.add('checked');
                else
                  radioItem.classList.remove('checked');
              }
              browser.runtime.sendMessage({
                type:    TSTAPI.kCONTEXT_ITEM_CHECKED_STATUS_CHANGED,
                id:      item.dataset.itemId,
                ownerId: item.dataset.itemOwnerId,
                checked: itemData.checked
              });
            }
          }
          mIsDirty = true;
        }
      }
    }; break;
  }
}

async function onShown(contextTab) {
  const message = {
    type: TSTAPI.kCONTEXT_MENU_SHOWN,
    info: {
      editable:         false,
      frameUrl:         null,
      linkUrl:          null,
      mediaType:        null,
      pageUrl:          null,
      selectionText:    null,
      srcUrl:           null,
      contexts:         ['tab'],
      menuIds:          []
    },
    tab: contextTab || mContextTab || null
  };
  return Promise.all([
    browser.runtime.sendMessage(message),
    TSTAPI.sendMessage(message)
  ]);
}

async function onHidden() {
  const message = {
    type: TSTAPI.kCONTEXT_MENU_HIDDEN
  };
  return Promise.all([
    browser.runtime.sendMessage(message),
    TSTAPI.sendMessage(message)
  ]);
}

function onMessage(message, _aSender) {
  log('tab-context-menu: internally called:', message);
  switch (message.type) {
    case TSTAPI.kCONTEXT_MENU_UPDATED: {
      importExtraItems(message.items);
      mIsDirty = true;
      if (mUI.opened)
        open(mLastOpenOptions);
    }; break;
  }
}

function importExtraItems(aItems) {
  mExtraItems.clear();
  for (const [id, items] of Object.entries(aItems)) {
    mExtraItems.set(id, items);
  }
}

function onExternalMessage(message, sender) {
  log('API called:', message, { id: sender.id, url: sender.url });
  switch (message.type) {
    case TSTAPI.kCONTEXT_MENU_OPEN:
      return (async () => {
        const tab      = message.tab ? (await browser.tabs.get(message.tab)) : null ;
        const windowId = message.window || tab && tab.windowId;
        if (windowId != Tabs.getWindow())
          return;
        await onShown(tab);
        await wait(25);
        return open({
          tab,
          windowId,
          left:     message.left,
          top:      message.top
        });
      })();
  }
}


async function onContextMenu(event) {
  if (!configs.fakeContextMenu)
    return;
  event.stopPropagation();
  event.preventDefault();
  const tab = EventUtils.getTabFromEvent(event);
  await onShown(tab && tab.apiTab);
  await wait(25);
  await open({
    tab:  tab && tab.apiTab,
    windowId: Tabs.getWindow(),
    left: event.clientX,
    top:  event.clientY
  });
}

// don't return promise, to avoid needless "await"
Tabs.onRemoving.addListener((_tab, _info) => { close(); });
Tabs.onMoving.addListener((_tab, _info) => { close(); });
Tabs.onActivated.addListener((_tab, _info) => { close(); });
Tabs.onCreating.addListener((_tab, _info) => { close(); });
Tabs.onPinned.addListener(_tab => { close(); });
Tabs.onUnpinned.addListener(_tab => { close(); });
Tabs.onShown.addListener(_tab => { close(); });
Tabs.onHidden.addListener(_tab => { close(); });
Tree.onAttached.addListener((_tab, _info) => { close(); });
Tree.onDetached.addListener((_tab, _info) => { close(); });
