import {
  liveLoaded,
  test, expect, type Page, routePlaylist, routeLiveManifest, seedPlaylist, PLAYLIST_URL, enterTab, readUserDataStore,
} from './helpers';
import type { Locator } from '@playwright/test';
import { seedXtream } from './fixtures/xtream';

// All Settings coverage: navigation, playlist save/removal, Xtream, and uploads.

test.describe('Settings navigation', () => {
  test('the Settings tab on the channel list opens settings', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);

    await page.goto('/');
    await liveLoaded(page);

    await enterTab(page, 'settings');

    await expect(page.locator('#view-settings')).toBeVisible();
    // The configured playlist URL is populated in the settings form.
    await expect(page.locator('.playlist-url').first()).toHaveValue(PLAYLIST_URL);
  });

  test('an open dropdown closes on an outside click or Back before leaving Settings', async ({ page }) => {
    await page.goto('/');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');

    await trigger.click();
    await expect(dropdown).toHaveClass(/open/);
    await page.locator('[data-settings-target="appearance"]').click();
    await expect(dropdown).not.toHaveClass(/open/);

    await trigger.click();
    await expect(dropdown).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(dropdown).not.toHaveClass(/open/);
    await expect(page.locator('#view-settings')).toBeVisible();
  });

  // A closed menu is `display: none` from the stylesheet, so its options carry
  // no hiding of their own and SpatialNav must keep d-pad out on measurement.
  // jsdom has no layout, so a real engine is the only place this can be checked.
  test('a closed dropdown keeps its options out of d-pad navigation', async ({ page }) => {
    await page.goto('/');
    const dropdown = page.locator('#app-language');
    const options = dropdown.locator('.dropdown-option');
    await expect(options.first()).not.toBeVisible();

    // The trigger is the first control of its pane, so nothing legitimate sits
    // above it. A hidden option measures as a zero-sized box at the viewport
    // origin, which is above everything and in the same container, so it is the
    // one thing Up could reach if measurement did not rule it out.
    await dropdown.locator('.dropdown-trigger')
      .evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('ArrowUp');

    expect(await page.locator('.dropdown-option.focused').count()).toBe(0);
  });

  test('an open dropdown keeps d-pad inside its own options', async ({ page }) => {
    await page.goto('/');
    const dropdown = page.locator('#app-language');
    await dropdown.locator('.dropdown-trigger').click();
    await expect(dropdown).toHaveClass(/open/);

    const optionCount = await dropdown.locator('.dropdown-option').count();
    expect(optionCount).toBeGreaterThan(1);

    // Walk past the end of the list; every step must stay among the options.
    for (let step = 0; step < optionCount + 3; step++) {
      await page.keyboard.press('ArrowDown');
      const inside = await page.evaluate(() =>
        !!document.querySelector('#view-settings .focused')?.closest('.dropdown.open'));
      expect(inside).toBe(true);
    }
  });

  // Pointer hover can move focus to the view behind an open menu. The next
  // keypress must re-enter the menu rather than continue through the background.
  test('an open dropdown recaptures focus after pointer hover escapes', async ({ page }) => {
    await page.goto('/');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');
    const outside = page.locator('[data-settings-target="appearance"]');
    await expect(trigger).toBeVisible();
    // Seed the pointer: before its first move, a mouseover can't be told
    // from content sliding under it, so it is ignored after a key.
    await page.mouse.move(1, 1);

    await trigger.evaluate(el => el.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true })));
    await page.keyboard.press('Enter');
    await expect(dropdown).toHaveClass(/open/);

    await outside.dispatchEvent('mouseover');
    await expect(outside).toHaveClass(/focused/);

    await page.keyboard.press('ArrowDown');

    const index = await page.evaluate(() => {
      const options = Array.from(document.querySelectorAll('#app-language .dropdown-option'));
      return options.findIndex(o => o.classList.contains('focused'));
    });
    expect(index).toBe(0);
  });

  // Entering a category focuses its first element in DOM order, with no
  // geometry to fall back on — so the visibility check is the only thing
  // standing between focus and an invisible element. A stylesheet rule is the
  // case no attribute selector on the element could ever catch, and jsdom
  // applies no stylesheets, so this needs a real engine.
  test('entering a category skips a first control hidden by a stylesheet', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const swatches = page.locator('#settings-appearance .theme-swatch');
    const names = await swatches.evaluateAll(els => els.map(el => el.getAttribute('data-theme')));
    expect(names.length).toBeGreaterThan(1);

    await page.addStyleTag({
      content: `#settings-appearance [data-theme="${names[0]}"] { display: none; }`,
    });

    await page.locator('[data-settings-target="appearance"]').click();
    await page.keyboard.press('ArrowRight');

    const focused = await page.evaluate(() =>
      document.querySelector('#view-settings .focused')?.getAttribute('data-theme') ?? null);
    expect(focused).toBe(names[1]);
  });

  test('keeps dropdown spacing aligned with adjacent settings', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#os-pref-lang')).toBeAttached();
    await expect(page.locator('#overlay-style')).toBeAttached();

    const gaps = await page.evaluate(() => {
      const titleGap = (selector: string): number => {
        const control = document.querySelector<HTMLElement>(selector)!;
        const title = control.closest('.settings-item')!
          .querySelector<HTMLElement>('.settings-item-title')!;
        return control.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
      };
      const rows = Array.from(document.querySelectorAll<HTMLElement>(
        '#settings-subtitles .settings-row',
      ));
      return {
        dropdownTitle: titleGap('#os-pref-lang'),
        toggleTitle: titleGap('#overlay-style'),
        dropdownToNextTitle: rows[0].querySelector('label')!.getBoundingClientRect().top
          - document.querySelector('#os-pref-lang')!.getBoundingClientRect().bottom,
        inputToNextTitle: rows[1].querySelector('label')!.getBoundingClientRect().top
          - document.querySelector('#subdl-key')!.getBoundingClientRect().bottom,
      };
    });

    expect(gaps.dropdownTitle).toBe(gaps.toggleTitle);
    expect(gaps.dropdownTitle).toBe(10);
    expect(gaps.dropdownToNextTitle).toBe(gaps.inputToNextTitle);
    expect(gaps.dropdownToNextTitle).toBe(12);
  });

  test('lays out Advanced settings as a continuous three-column matrix', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-settings-target="advanced"]').click();

    await expect(page.locator('#settings-advanced .settings-section-title')).toHaveText('Advanced');
    const layouts = await page.locator(
      '#settings-advanced .settings-advanced-row',
    )
      .evaluateAll((rows) => rows.map((row) => {
        const bounds = row.getBoundingClientRect();
        const group = row.querySelector<HTMLElement>('.settings-advanced-group')!
          .getBoundingClientRect();
        const title = row.querySelector<HTMLElement>('.settings-item-title')!
          .getBoundingClientRect();
        const control = row.querySelector<HTMLElement>('.dropdown, .toggle-group')!
          .getBoundingClientRect();
        const hint = row.querySelector<HTMLElement>('.settings-item-hint')!
          .getBoundingClientRect();
        return {
          rowCenter: bounds.top + bounds.height / 2,
          controlCenter: control.top + control.height / 2,
          controlRightGap: bounds.right - control.right,
          groupRight: group.right,
          titleLeft: title.left,
          titleBottom: title.bottom,
          hintTop: hint.top,
        };
      }));

    expect(layouts).toHaveLength(7);
    for (const layout of layouts) {
      expect(Math.abs(layout.controlCenter - layout.rowCenter)).toBeLessThanOrEqual(1);
      expect(layout.controlRightGap).toBe(20);
      expect(layout.titleLeft).toBeGreaterThan(layout.groupRight);
      expect(layout.hintTop).toBeGreaterThan(layout.titleBottom);
    }

    const numberEntry = page.locator('#number-entry-osd-timeout .dropdown-trigger');
    await numberEntry.click();
    const focusedRow = numberEntry.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "),'
        + ' " settings-advanced-row ")][1]',
    );
    await expect(focusedRow).not.toHaveCSS('box-shadow', 'none');
  });

  test('persists Essential mode and disables only costly motion', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-settings-target="advanced"]').click();
    const animationOptions = page.locator('#animation-mode .toggle-option');
    await expect(animationOptions).toHaveCount(3);
    expect(await animationOptions.evaluateAll(options => options.map(
      option => (option as HTMLElement).dataset.value,
    )))
      .toEqual(['essential', 'reduced', 'full']);
    const animationRow = await page.evaluate(() => {
      const row = document.querySelector(
        '#settings-advanced .settings-advanced-row',
      )!.getBoundingClientRect();
      const options = document.querySelector('#animation-mode')!.getBoundingClientRect();
      return {
        rowCenter: row.top + row.height / 2,
        optionsCenter: options.top + options.height / 2,
      };
    });
    expect(animationRow.optionsCenter).toBeCloseTo(animationRow.rowCenter, 0);
    await page.locator('#animation-mode [data-value="essential"]').click();
    await page.locator('#save-settings').click();

    await expect(page.locator('html')).toHaveAttribute('data-animation', 'essential');
    const durations = await page.evaluate(() => {
      const seconds = (value: string): number[] => value.split(',')
        .map(part => parseFloat(part.trim()))
        .filter(Number.isFinite);
      const liveBadge = document.createElement('span');
      liveBadge.className = 'live-badge-dot';
      document.body.appendChild(liveBadge);
      const motionFixtures = document.createElement('div');
      motionFixtures.innerHTML = `
        <div class="channel-item"></div>
        <span class="playing-indicator"></span>
        <div class="search-history-scrim"></div>
        <div class="search-history-panel"></div>
        <div class="epg-programme-item state-live"></div>
        <div class="player-sidebar visible channels-only">
          <div class="sidebar-picker-arrow"><svg></svg></div>
          <div class="sidebar-ch-item">
            <div class="ch-name"><span class="ch-name-text scrolling"></span></div>
            <div class="ch-now"><span class="ch-now-text scrolling"></span></div>
          </div>
        </div>
      `;
      document.body.appendChild(motionFixtures);
      const result = {
        button: seconds(getComputedStyle(document.querySelector('#save-settings')!)
          .transitionDuration),
        search: seconds(getComputedStyle(document.querySelector('.tab-bar-search-input')!)
          .transitionDuration),
        channelRow: seconds(getComputedStyle(motionFixtures.querySelector('.channel-item')!)
          .transitionDuration),
        sidebarRow: seconds(getComputedStyle(motionFixtures.querySelector('.sidebar-ch-item')!)
          .transitionDuration),
        liveBadge: getComputedStyle(liveBadge).animationName,
        playingIndicator: getComputedStyle(
          motionFixtures.querySelector('.playing-indicator')!,
        ).animationName,
        historyScrim: getComputedStyle(
          motionFixtures.querySelector('.search-history-scrim')!,
        ).animationName,
        historyPanel: getComputedStyle(
          motionFixtures.querySelector('.search-history-panel')!,
        ).animationName,
        epgLiveRail: getComputedStyle(
          motionFixtures.querySelector('.epg-programme-item')!,
          '::before',
        ).animationName,
        groupPicker: getComputedStyle(
          motionFixtures.querySelector('.sidebar-picker-arrow svg')!,
        ).animationName,
        channelMarquee: getComputedStyle(
          motionFixtures.querySelector('.ch-name-text')!,
        ).animationName,
        programmeMarquee: getComputedStyle(
          motionFixtures.querySelector('.ch-now-text')!,
        ).animationName,
      };
      liveBadge.remove();
      motionFixtures.remove();
      return result;
    });
    expect(durations.search.every(value => value <= 0.000001)).toBe(true);
    expect(durations.button.some(value => value >= 0.1)).toBe(true);
    expect(durations.channelRow.every(value => value <= 0.000001)).toBe(true);
    expect(durations.sidebarRow.every(value => value <= 0.000001)).toBe(true);
    expect(durations.liveBadge).toBe('liveBadgeDotPulse');
    expect(durations.playingIndicator).toBe('none');
    expect(durations.historyScrim).toBe('none');
    expect(durations.historyPanel).toBe('none');
    expect(durations.epgLiveRail).toBe('epgRailPulse');
    expect(durations.groupPicker).toBe('group-picker-nudge');
    expect(durations.channelMarquee).toBe('marquee-bounce');
    expect(durations.programmeMarquee).toBe('marquee-bounce');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-animation', 'essential');
  });

  test('Reduced mode keeps list focus, the playing pulse, and the history fade', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-animation', 'reduced');
    const motion = await page.evaluate(() => {
      const fixtures = document.createElement('div');
      fixtures.innerHTML = `
        <div class="channel-item"></div>
        <span class="playing-indicator"></span>
        <div class="search-history-scrim"></div>
        <div class="search-history-panel"></div>
        <div class="player-sidebar"><div class="sidebar-ch-item"></div></div>
      `;
      document.body.appendChild(fixtures);
      const style = (selector: string) => getComputedStyle(fixtures.querySelector(selector)!);
      const result = {
        channelRow: style('.channel-item').transitionDuration,
        sidebarRow: style('.sidebar-ch-item').transitionDuration,
        playingIndicator: style('.playing-indicator').animationName,
        historyScrim: style('.search-history-scrim').animationName,
        historyPanel: style('.search-history-panel').animationName,
      };
      fixtures.remove();
      return result;
    });
    expect(motion.channelRow).toBe('0.2s');
    expect(motion.sidebarRow).toBe('0.2s');
    expect(motion.playingIndicator).toBe('pulse');
    expect(motion.historyScrim).toBe('search-history-in');
    expect(motion.historyPanel).toBe('search-history-in');
  });

  test('data-animation CSS owns the navigation scroll policy', async ({ page }) => {
    await page.goto('/');
    for (const [mode, expected] of [
      ['essential', 'auto'],
      ['reduced', 'auto'],
      ['full', 'smooth'],
    ] as const) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_animation_mode', JSON.stringify(value));
      }, mode);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-animation', mode);
      const policy = await page.locator('.settings-scroll').evaluate((element) => ({
        supported: typeof document.documentElement.style.scrollBehavior === 'string',
        value: getComputedStyle(element).scrollBehavior,
      }));
      if (policy.supported) expect(policy.value).toBe(expected);
    }
  });

  test('keeps localized animation profile controls on one line', async ({ page }) => {
    const locales = ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'uk', 'zh-CN'];
    await page.goto('/');

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await page.reload();
      await page.locator('[data-settings-target="advanced"]').click();

      const layout = await page.locator('#animation-mode').evaluate((group) => {
        const section = group.closest<HTMLElement>('.settings-section')!;
        const row = group.closest<HTMLElement>('.settings-advanced-row')!;
        const buttons = Array.from(group.querySelectorAll<HTMLElement>('.toggle-option'));
        const matrixGroups = Array.from(
          section.querySelectorAll<HTMLElement>('.settings-advanced-group'),
        );
        return {
          buttonCount: buttons.length,
          wrapped: buttons.filter((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            return range.getClientRects().length !== 1;
          }).map(button => button.textContent?.trim() ?? ''),
          groupOverlaps: matrixGroups.filter((matrixGroup) => {
            if (!matrixGroup.textContent?.trim()) return false;
            const range = document.createRange();
            range.selectNodeContents(matrixGroup);
            const description = matrixGroup.nextElementSibling!.getBoundingClientRect();
            return range.getBoundingClientRect().right > description.left;
          }).map(matrixGroup => matrixGroup.textContent?.trim() ?? ''),
          groupRight: Math.round(group.getBoundingClientRect().right),
          hintRight: Math.round(
            row.querySelector<HTMLElement>('.settings-item-hint')!
              .getBoundingClientRect().right,
          ),
          sectionRight: Math.round(section.getBoundingClientRect().right),
        };
      });

      expect(layout.buttonCount, locale).toBe(3);
      expect(layout.wrapped, locale).toEqual([]);
      expect(layout.groupOverlaps, locale).toEqual([]);
      expect(layout.groupRight, locale).toBeLessThanOrEqual(layout.sectionRight);
      expect(layout.hintRight, locale).toBeLessThanOrEqual(layout.sectionRight);
    }
  });

  test('keeps the HTTP headers options one line and as tall as other toggles beside a long hint', async ({ page }) => {
    const locales = ['en', 'de', 'es', 'fr', 'it', 'pl', 'pt-BR', 'ru', 'tr', 'uk', 'zh-CN'];
    await page.goto('/');

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
        localStorage.setItem('iptv_text_size', JSON.stringify('150'));
      }, locale);
      await page.reload();
      await page.locator('[data-settings-target="advanced"]').click();

      const layout = await page.locator('#header-playback').evaluate((group) => {
        const buttons = Array.from(group.querySelectorAll<HTMLElement>('.toggle-option'));
        const section = group.closest<HTMLElement>('.settings-section')!;
        return {
          wrapped: buttons.filter((button) => {
            const range = document.createRange();
            range.selectNodeContents(button);
            return range.getClientRects().length !== 1;
          }).map(button => button.textContent?.trim() ?? ''),
          heights: buttons.map(button => Math.round(button.getBoundingClientRect().height)),
          reference: Math.round(document.querySelector<HTMLElement>('#animation-mode .toggle-option')!
            .getBoundingClientRect().height),
          groupRight: Math.round(group.getBoundingClientRect().right),
          sectionRight: Math.round(section.getBoundingClientRect().right),
        };
      });

      expect(layout.wrapped, locale).toEqual([]);
      expect(layout.heights, locale).toEqual([layout.reference, layout.reference, layout.reference]);
      expect(layout.groupRight, locale).toBeLessThanOrEqual(layout.sectionRight);
    }
  });

  test('the action bar sits below the scroll viewport and stays put while scrolling', async ({ page }) => {
    await page.goto('/');
    const main = page.locator('.settings-main');
    const scroll = page.locator('.settings-scroll');
    const actions = page.locator('.settings-actions');

    const [mainBox, scrollBox, actionBox] = await Promise.all([
      main.boundingBox(),
      scroll.boundingBox(),
      actions.boundingBox(),
    ]);
    expect(mainBox).not.toBeNull();
    expect(scrollBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.x).toBeLessThanOrEqual(mainBox!.x);
    expect(actionBox!.y).toBeGreaterThanOrEqual(scrollBox!.y + scrollBox!.height - 1);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height + 1);

    // `position: sticky` is Chromium 56, so the bar must hold its place
    // through the layout itself rather than through the scroll position.
    await scroll.evaluate((el) => {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = el.scrollHeight;
    });
    const scrolled = await actions.boundingBox();
    expect(scrolled!.y).toBeCloseTo(actionBox!.y, 0);
  });

  test('clicking Cancel in settings (opened via the tab bar) returns to the channel list, not the player', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await liveLoaded(page);

    // Open settings via the tab bar, then dismiss with Cancel.
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('#cancel-settings').click();

    // Give the document-level deferred select (setTimeout 0) a chance to fire,
    // then assert we still land on the channel list rather than the player.
    // Before the fix, that second select fired on the channels view and played
    // the focused channel.
    await page.waitForTimeout(50);
    await liveLoaded(page);
    await expect(page.locator('#view-player')).toBeHidden();
    await expect(page.locator('#view-settings')).toBeHidden();
  });

  test('keeps Magic Remote hover separate from the weak scroll-position indicator', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const general = page.locator('[data-settings-target="general"]');
    const appearance = page.locator('[data-settings-target="appearance"]');
    const playback = page.locator('[data-settings-target="playback"]');
    const data = page.locator('[data-settings-target="data"]');

    await playback.hover();
    await expect(playback).toHaveClass(/focused/);
    await expect(general).toHaveClass(/active/);

    await appearance.click();
    await expect(appearance).toHaveClass(/active/);
    await page.locator('.settings-scroll').evaluate((main) => {
      (main as HTMLElement).style.scrollBehavior = 'auto';
      main.scrollTop = main.scrollHeight;
      main.dispatchEvent(new Event('scroll'));
    });

    await expect(data).toHaveClass(/active/);
    await playback.hover();
    await expect(playback).toHaveClass(/focused/);
    await expect(data).toHaveClass(/active/);
  });

  test('scales buttons consistently for pointer and D-pad focus', async ({ page }) => {
    await page.goto('/');
    const playback = page.locator('[data-settings-target="playback"]');

    await playback.hover();
    await expect(playback).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');

    await page.locator('.settings-title').hover();
    await expect(playback).not.toHaveClass(/focused/);
    await expect(playback).toHaveCSS('transform', 'none');

    await page.keyboard.press('ArrowDown');
    const focusedButton = page.locator('#view-settings button.focused');
    await expect(focusedButton).toHaveCount(1);
    await expect(focusedButton).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');

    const toggle = page.locator('.toggle-option').first();
    await toggle.hover();
    await expect(toggle).toHaveClass(/focused/);
    await expect(toggle).toHaveCSS('transform', 'none');
  });

  test('keeps scaled dropdown controls inside their scroll containers', async ({ page }) => {
    await page.goto('/');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');

    await trigger.hover();
    await expect(trigger).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');
    const triggerBounds = await page.evaluate(() => {
      const main = document.querySelector('.settings-main')!.getBoundingClientRect();
      const control = document.querySelector('#app-language .dropdown-trigger')!
        .getBoundingClientRect();
      return {
        leftInset: control.left - main.left,
        rightInset: main.right - control.right,
      };
    });
    expect(triggerBounds.leftInset).toBeGreaterThanOrEqual(0);
    expect(triggerBounds.rightInset).toBeGreaterThanOrEqual(0);

    await trigger.click();
    const option = dropdown.locator('.dropdown-option').first();
    await option.hover();
    await expect(option).toHaveCSS('transform', 'matrix(1.03, 0, 0, 1.03, 0, 0)');
    const optionBounds = await page.evaluate(() => {
      const menu = document.querySelector('#app-language .dropdown-menu')!
        .getBoundingClientRect();
      const item = document.querySelector('#app-language .dropdown-option')!
        .getBoundingClientRect();
      return {
        leftInset: item.left - menu.left,
        rightInset: menu.right - item.right,
        topInset: item.top - menu.top,
      };
    });
    expect(optionBounds.leftInset).toBeGreaterThanOrEqual(0);
    expect(optionBounds.rightInset).toBeGreaterThanOrEqual(0);
    expect(optionBounds.topInset).toBeGreaterThanOrEqual(0);
  });

  test('keeps the clicked indicator and Data title visible after smooth scrolling', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.evaluate(() => {
      const changes: string[] = [];
      (window as typeof window & { __settingsActiveChanges: string[] }).__settingsActiveChanges = changes;
      new MutationObserver(() => {
        const active = document.querySelector<HTMLElement>('.settings-nav-item.active')
          ?.dataset.settingsTarget;
        if (active && changes[changes.length - 1] !== active) changes.push(active);
      }).observe(document.querySelector('.settings-nav-list')!, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class'],
      });
    });

    const data = page.locator('[data-settings-target="data"]');
    await data.hover();
    await page.evaluate(() => {
      (window as typeof window & { __settingsActiveChanges: string[] }).__settingsActiveChanges.length = 0;
    });
    await data.click();
    await expect.poll(() => page.evaluate(() => {
      const main = document.querySelector('.settings-main')!.getBoundingClientRect();
      const title = document.querySelector('#settings-data .settings-section-title')!
        .getBoundingClientRect();
      return title.top >= main.top - 1 && title.bottom <= main.bottom + 1;
    })).toBe(true);

    const changes = await page.evaluate(() =>
      (window as typeof window & { __settingsActiveChanges: string[] }).__settingsActiveChanges);
    expect(changes).toEqual(['data']);
  });

  test('Right enters the selected sidebar category without changing its weak indicator', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const guide = page.locator('[data-settings-target="guide"]');
    await guide.dispatchEvent('nav:hover');
    await page.keyboard.press('ArrowRight');

    await expect(page.locator('#add-epg-source')).toHaveClass(/focused/);
    await expect(guide).toHaveClass(/active/);
  });

  test('Left returns from a category content boundary to its sidebar item', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const guide = page.locator('[data-settings-target="guide"]');
    await guide.dispatchEvent('nav:hover');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#add-epg-source')).toHaveClass(/focused/);

    await page.keyboard.press('ArrowLeft');
    await expect(guide).toHaveClass(/focused/);
  });

  test('keeps every localized sidebar label on one line', async ({ page }) => {
    const locales = ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'uk', 'zh-CN'];
    await page.goto('/');

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);

      const result = await page.locator('.settings-sidebar').evaluate((sidebar) => {
        const bad = Array.from(sidebar.querySelectorAll<HTMLElement>(
          '.settings-nav-item, .settings-nav-help-row'))
          .filter((item) => {
            const label = item.lastElementChild;
            if (!label) return true;
            const range = document.createRange();
            range.selectNodeContents(label);
            return range.getClientRects().length !== 1 || item.scrollWidth > item.clientWidth;
          })
          .map((item) => item.textContent?.trim() ?? '');
        return { bad, width: Math.round(sidebar.getBoundingClientRect().width) };
      });

      expect(result.bad, locale).toEqual([]);
      expect(result.width, locale).toBeGreaterThanOrEqual(252);
      expect(result.width, locale).toBeLessThanOrEqual(328);
    }
  });

  test('keeps localized EPG time correction text and controls within the section', async ({ page }) => {
    const locales = ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'uk', 'zh-CN'];
    await page.goto('/');

    for (const locale of locales) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await page.reload();
      await page.locator('[data-settings-target="guide"]').click();

      const layout = await page.locator('.epg-offset-controls').evaluate((controls) => {
        const item = controls.closest<HTMLElement>('.settings-item')!;
        const section = controls.closest<HTMLElement>('.settings-section')!;
        const dropdown = controls.querySelector<HTMLElement>('.dropdown')!;
        const stepper = controls.querySelector<HTMLElement>('.epg-offset-stepper')!;
        const sectionRight = section.getBoundingClientRect().right;
        const overflowing = Array.from(item.querySelectorAll<HTMLElement>(
          '.settings-item-title, .settings-item-hint, .epg-offset-controls',
        )).filter(element =>
          element.scrollWidth > element.clientWidth + 1
          || element.getBoundingClientRect().right > sectionRight + 1)
          .map(element => element.textContent?.trim() ?? '');
        const hintLines = Array.from(item.querySelectorAll<HTMLElement>('.settings-item-hint'))
          .map(element => Math.round(
            element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
          ));
        return {
          overflowing,
          hintLines,
          dropdownTop: Math.round(dropdown.getBoundingClientRect().top),
          stepperTop: Math.round(stepper.getBoundingClientRect().top),
          controlsRight: Math.round(controls.getBoundingClientRect().right),
          sectionRight: Math.round(sectionRight),
        };
      });

      expect(layout.overflowing, locale).toEqual([]);
      expect(Math.max(...layout.hintLines), locale).toBeLessThanOrEqual(2);
      expect(layout.stepperTop, locale).toBe(layout.dropdownTop);
      expect(layout.controlsRight, locale).toBeLessThanOrEqual(layout.sectionRight);
    }
  });

  test('lays out the 15 theme swatches across three full rows', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-settings-target="appearance"]').click();

    const rowCounts = await page.locator('.theme-swatch').evaluateAll((swatches) => {
      const rows = new Map<number, number>();
      for (const swatch of swatches) {
        const top = Math.round(swatch.getBoundingClientRect().top);
        rows.set(top, (rows.get(top) ?? 0) + 1);
      }
      return Array.from(rows.values());
    });

    expect(rowCounts).toEqual([5, 5, 5]);
  });

  test('selects and saves Local proxy for HTTP headers', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="advanced"]').click();

    const proxy = page.locator('#header-playback .toggle-option[data-value="proxy"]');
    await expect(proxy).toBeEnabled();
    await proxy.click();
    await expect(proxy).toHaveClass(/active/);
    await page.locator('#save-settings').click();
    await liveLoaded(page);
    expect(await page.evaluate(() => localStorage.getItem('iptv_header_playback'))).toBe('"proxy"');

    await page.reload();
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="advanced"]').click();
    await expect(proxy).toHaveClass(/active/);
  });

  test('the text size picker scales only fonts and persists', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();

    const title = page.locator('.settings-title');
    const fontSize = () => title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const base = await fontSize();

    await page.locator('[data-settings-target="appearance"]').click();
    await page.locator('#text-size .dropdown-trigger').click();
    const option = page.locator('#text-size .dropdown-option[data-dropdown-value="130"]');
    await expect(option).toBeVisible();
    await option.click();
    // Live preview: the scale applies before saving.
    expect(await fontSize()).toBeCloseTo(base * 1.3, 1);

    await page.locator('#save-settings').click();
    await liveLoaded(page);

    // Persisted across a relaunch and applied outside Settings, without
    // changing the dimensions of controls.
    await page.reload();
    await liveLoaded(page);
    const row = page.locator('.channel-item').first();
    const metrics = () => row.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        font: parseFloat(getComputedStyle(el.querySelector('.channel-name')!).fontSize),
        height: parseFloat(cs.height),
        padding: parseFloat(cs.paddingLeft),
        logo: parseFloat(getComputedStyle(el.querySelector('.channel-logo-wrap')!).width),
      };
    });
    const scaled = await metrics();
    // Same measurements at the default size, from a clean load.
    await page.evaluate(() => localStorage.removeItem('iptv_text_size'));
    await page.reload();
    await liveLoaded(page);
    const unscaled = await metrics();
    expect(scaled.font).toBeCloseTo(unscaled.font * 1.3, 1);
    for (const key of ['height', 'padding', 'logo'] as const)
      expect(scaled[key], key).toBeCloseTo(unscaled[key], 1);
  });
});

// What shows focus in Settings: lit controls, plus a field with the caret.
const rings = (page: Page) => page.evaluate(() => {
  const view = document.getElementById('view-settings')!;
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
  };
  const lit: Element[] = Array.from(view.querySelectorAll('.focused')).filter(shown);
  const active = document.activeElement;
  if (active instanceof HTMLInputElement && view.contains(active) && !lit.includes(active)) lit.push(active);
  return lit.map(el => el.id || el.className);
});

test.describe('Settings hover under the tab bar', () => {
  const lit = (locator: Locator) => locator.evaluate(el => el.classList.contains('focused'));

  test('a control hovered under the open account menu lights where the pointer rests', async ({ page }) => {
    await seedXtream(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();

    await page.locator('.tab-bar .account-avatar').click();
    await expect(page.locator('.tab-bar .account-menu')).toBeVisible();
    await expect(page.locator('.tab-bar .account-menu-item.focused')).toHaveCount(1);

    const category = page.locator('#view-settings .settings-nav-item').nth(1);
    await category.hover();
    await expect.poll(() => lit(category)).toBe(true);
    await expect.poll(() => rings(page)).toHaveLength(1);

    const save = page.locator('#save-settings');
    await save.hover();
    await expect.poll(() => rings(page)).toEqual(['save-settings']);
    expect(await lit(category)).toBe(false);
    await expect(page.locator('.tab-bar .account-menu')).toBeVisible();
  });

  test('a control hovered after the pointer left the focused one, while the tab bar has the keys, lights', async ({ page }) => {
    await seedXtream(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();

    const first = page.locator('#view-settings .settings-nav-item').first();
    await first.hover();
    await expect.poll(() => lit(first)).toBe(true);
    // Up from the first category leaves for the tab bar.
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.tab-bar .focused')).toHaveCount(1);

    const save = page.locator('#save-settings');
    await save.hover();
    await expect.poll(() => rings(page)).toEqual(['save-settings']);
    await expect(page.locator('#view-settings')).toHaveAttribute('data-ring-owner', '');
    await expect(page.locator('.tab-bar .focused')).toHaveCount(0);
  });
});

test.describe('Settings text fields', () => {
  test('OK on a field the pointer left only shows it', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-settings-target="subtitles"]').click();
    const field = page.locator('#subdl-key');

    await field.hover();
    await expect(field).toHaveClass(/focused/);
    await page.locator('#settings-subtitles .settings-section-title').hover();
    await expect(field).not.toHaveClass(/focused/);

    // Nobody can see the field, so OK must not put a caret in it.
    await page.keyboard.press('Enter');
    await expect(field).toHaveClass(/focused/);
    await expect(field).not.toBeFocused();
    await page.keyboard.press('Enter');
    await expect(field).toBeFocused();
  });

  test('a field with the caret keeps the only ring, and Back or Up let the caret go', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-settings-target="subtitles"]').click();
    const field = page.locator('#subdl-key');
    const save = page.locator('#save-settings');

    await field.click();
    await expect(field).toBeFocused();
    // While the caret is in the field, a hovered button is not lit beside it.
    await save.hover();
    await expect.poll(() => rings(page)).toEqual(['subdl-key']);

    await page.keyboard.press('Escape');
    await expect(field).not.toBeFocused();
    await expect.poll(() => rings(page)).toEqual(['subdl-key']);

    await page.keyboard.press('Enter');
    await expect(field).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(field).not.toBeFocused();
    await expect.poll(async () => (await rings(page)).length).toBe(1);
    await expect(save).not.toHaveClass(/focused/);
    await expect(field).not.toHaveClass(/focused/);
  });
});

test.describe('Settings re-entry', () => {
  const RED = 403;
  const BLUE = 406;
  const WEBOS_BACK = 461;
  const remoteKey = (page: Page, keyCode: number) => page.evaluate(
    (code) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })),
    keyCode,
  );
  const activeCategory = (page: Page) => page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#view-settings .settings-nav-item.active'))
      .map(item => item.dataset.settingsTarget));
  // The category once the pane has held still for a while.
  const settledCategory = (page: Page) => page.evaluate(() => new Promise<string[]>((resolve) => {
    const pane = document.querySelector<HTMLElement>('#view-settings .settings-scroll')!;
    let last = pane.scrollTop;
    let still = 0;
    const step = () => {
      still = pane.scrollTop === last ? still + 1 : 0;
      last = pane.scrollTop;
      if (still < 30) { requestAnimationFrame(step); return; }
      resolve(Array.from(document.querySelectorAll<HTMLElement>('#view-settings .settings-nav-item.active'))
        .map(item => item.dataset.settingsTarget!));
    };
    requestAnimationFrame(step);
  }));
  // The category the focused control sits in.
  const focusedCategory = (page: Page) => page.evaluate(() =>
    document.querySelector<HTMLElement>('#view-settings .settings-scroll [data-focusable].focused')
      ?.closest<HTMLElement>('.settings-category')?.dataset.settingsCategory ?? null);
  // The category whose heading has reached the top of the pane.
  const scrolledCategory = (page: Page) => page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('#view-settings .settings-scroll')!;
    const sections = Array.from(pane.querySelectorAll<HTMLElement>('.settings-category'));
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) {
      return sections[sections.length - 1].dataset.settingsCategory!;
    }
    const threshold = pane.getBoundingClientRect().top + 48;
    let active = sections[0].dataset.settingsCategory!;
    for (const section of sections) {
      if (section.getBoundingClientRect().top > threshold) break;
      active = section.dataset.settingsCategory!;
    }
    return active;
  });
  // Leaves Settings on Add playlist for Live and comes back.
  const leaveFromAddPlaylist = async (page: Page) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.keyboard.press('ArrowRight');
    const add = page.locator('#add-playlist');
    for (let step = 0; step < 20 && !(await add.evaluate(el => el.classList.contains('focused'))); step++) {
      await page.keyboard.press('ArrowDown');
    }
    await expect(add).toHaveClass(/\bfocused\b/);

    await enterTab(page, 'live');
    await liveLoaded(page);
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => rings(page)).toEqual(['add-playlist']);
  };

  test('a dropdown option left for another section comes back as its trigger', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    const dropdown = page.locator('#app-language');
    const trigger = dropdown.locator('.dropdown-trigger');
    await trigger.click();
    await expect(dropdown).toHaveClass(/open/);
    await page.keyboard.press('ArrowDown');
    await expect(dropdown.locator('.dropdown-option.focused')).toHaveCount(1);

    await remoteKey(page, RED);
    await expect(page.locator('#view-epg')).toBeVisible();
    await remoteKey(page, BLUE);
    await expect(page.locator('#view-settings')).toBeVisible();

    await expect(dropdown).not.toHaveClass(/open/);
    await expect.poll(() => rings(page)).toEqual([await trigger.getAttribute('class')]);
    await page.keyboard.press('Enter');
    await expect(dropdown).toHaveClass(/open/);
  });

  test('switching back from another tab returns to the last control and its category', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="guide"]').click();
    await page.keyboard.press('ArrowRight');
    const control = page.locator('#settings-guide [data-focusable].focused');
    await expect(control).toHaveCount(1);
    const name = await control.evaluate(el => el.id || el.className);

    await enterTab(page, 'live');
    await liveLoaded(page);
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => rings(page)).toEqual([name]);
    await expect.poll(() => activeCategory(page)).toEqual(['guide']);
  });

  test('with full animation, coming back to a lower control keeps its category once the scroll settles', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.keyboard.press('ArrowRight');
    const add = page.locator('#add-playlist');
    for (let step = 0; step < 20 && !(await add.evaluate(el => el.classList.contains('focused'))); step++) {
      await page.keyboard.press('ArrowDown');
    }
    await expect(add).toHaveClass(/\bfocused\b/);

    await enterTab(page, 'live');
    await liveLoaded(page);
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => rings(page)).toEqual(['add-playlist']);

    expect(await settledCategory(page)).toEqual(['sources']);
    await expect(add).toBeInViewport();
  });

  test('Down into the next category while the pane settles marks that category', async ({ page }) => {
    await leaveFromAddPlaylist(page);

    // A held key: each press follows the last with no pause.
    for (let step = 0; step < 30 && (await focusedCategory(page)) !== 'guide'; step++) {
      await page.keyboard.press('ArrowDown');
    }
    expect(await focusedCategory(page)).toBe('guide');
    expect(await settledCategory(page)).toEqual(['guide']);
  });

  test('with full animation, a wheel while the pane settles lets the scroll pick the category', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
    await leaveFromAddPlaylist(page);

    const pane = await page.locator('#view-settings .settings-scroll').boundingBox();
    if (!pane) throw new Error('the settings pane has no bounding box');
    // In the pane's padding, so no control comes under the pointer as it scrolls.
    await page.mouse.move(pane.x + 4, pane.y + pane.height / 2);
    for (let step = 0; step < 12; step++) await page.mouse.wheel(0, 300);

    const settled = await settledCategory(page);
    const scrolled = await scrolledCategory(page);
    expect(scrolled).not.toBe('sources');
    expect(settled).toEqual([scrolled]);
  });

  test('with full animation, Right from a category keeps it once the pane settles', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('iptv_animation_mode', JSON.stringify('full')));
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    const guide = page.locator('[data-settings-target="guide"]');
    for (let step = 0; step < 6 && !(await guide.evaluate(el => el.classList.contains('focused'))); step++) {
      await page.keyboard.press('ArrowDown');
    }
    await expect(guide).toHaveClass(/\bfocused\b/);
    expect(await settledCategory(page)).toEqual(['general']);

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => focusedCategory(page)).toBe('guide');
    expect(await settledCategory(page)).toEqual(['guide']);
  });

  test('Back from parental controls returns to the control that opened them', async ({ page }) => {
    await routePlaylist(page);
    await routeLiveManifest(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    const manage = page.locator('#manage-parental-controls');
    await manage.click();
    const prompt = page.locator('.parental-pin-prompt');
    await prompt.locator('.parental-pin-input').fill('1234');
    await expect(prompt.locator('h2')).toContainText('Confirm');
    await prompt.locator('.parental-pin-input').fill('1234');
    await expect(page.locator('#view-parental-controls')).toBeVisible();

    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#view-settings')).toBeVisible();
    await expect.poll(() => rings(page)).toEqual(['manage-parental-controls']);
    const category = await manage.evaluate(el =>
      el.closest<HTMLElement>('.settings-category')?.dataset.settingsCategory);
    await expect.poll(() => activeCategory(page)).toEqual([category]);
  });

  test('coming back from the channel editor returns to its button', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.locator('#edit-channel-list').click();
    await liveLoaded(page);
    await expect(page.locator('.edit-hints')).toBeVisible();

    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => rings(page)).toEqual(['edit-channel-list']);
    await expect.poll(() => activeCategory(page)).toEqual(['sources']);
  });

  test('the remote Back key in a text field lets the caret go and stays in Settings', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-settings-target="subtitles"]').click();
    const field = page.locator('#subdl-key');
    await field.click();
    await expect(field).toBeFocused();

    await field.evaluate((input, code) => input.dispatchEvent(
      new KeyboardEvent('keydown', { keyCode: code, bubbles: true, cancelable: true })), WEBOS_BACK);
    await expect(field).not.toBeFocused();
    await expect.poll(() => rings(page)).toEqual(['subdl-key']);
    await expect(page.locator('#view-settings')).toBeVisible();
  });
});

test.describe('Settings playlists', () => {
  test('saving a playlist in settings reloads and shows its channels', async ({ page }) => {
    await routePlaylist(page);
    await page.goto('/');

    // First run with no playlist opens settings.
    await expect(page.locator('#view-settings')).toBeVisible();

    // Add a playlist row and fill in its URL.
    await page.locator('#add-playlist').click();
    await page.locator('.playlist-name').first().fill('Saved');
    await page.locator('.playlist-url').first().fill(PLAYLIST_URL);

    // Drive Save via the remote-style focus + Enter path (avoids the click's
    // deferred select firing on the channel view after the reload). Use an
    // explicit CustomEvent so SpatialNav's parent-bound listener receives a
    // bubbling nav:hover.
    await page.locator('.playlist-url').first().blur();
    await page.evaluate(() => {
      document.getElementById('save-settings')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    });
    await page.keyboard.press('Enter');

    await liveLoaded(page);
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel One' })).toBeVisible();
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel Two' })).toBeVisible();
  });

  test('removing the last playlist clears in-memory channels so back returns an empty list', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');

    // Channels render from the configured playlist.
    await liveLoaded(page);
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(2);

    // Open settings, remove the only playlist, and save.
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('.remove-playlist').first().click();
    await expect(page.locator('#playlist-entries .settings-row')).toHaveCount(0);
    // Save via the keyboard path so the deferred-select skip-list does not
    // matter here (this test is about stale in-memory state, not click wiring).
    // Use page.evaluate for an explicit CustomEvent so SpatialNav's parent-
    // bound listener definitely receives the bubbling nav:hover.
    await page.evaluate(() => {
      document.getElementById('save-settings')!
        .dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
    });
    await page.keyboard.press('Enter');

    // loadData re-opens settings because there are no playlists now. Wait for
    // its completion toast before pressing Back; Settings was already visible
    // before Save, so visibility alone cannot distinguish completion.
    await expect(page.locator('.toast.visible'))
      .toContainText('Welcome! Add a playlist URL to get started.');

    // Press Back to return to the channel list — it must NOT show the previous
    // playlist's channels (the bug: PlaylistService kept stale in-memory state).
    // Use dispatchEvent(KeyboardEvent) rather than page.keyboard.press('Escape')
    // — in this Playwright/Chromium combo press('Escape') gets consumed by
    // native key handling before any JS keydown listener fires (verified by
    // tracing: keyCode=13 Enter pressed via press() reaches KeyHandler, but
    // keyCode=27 Escape pressed via press() never does).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    });
    await liveLoaded(page);
    await expect(page.locator('.channel-main .channel-item')).toHaveCount(0);
    await expect(page.locator('.empty-state')).toContainText('No channels found');
  });

  // Regression: a global document click handler fired a deferred "select" after
  // the clicked Remove button detached (its `.settings-view` ancestor gone, so
  // the guard missed it), deleting a second row — clicking Remove on row N wiped
  // out N and N+1. waitForTimeout lets that deferred select fire.
  test.describe('playlist removal', () => {
    // Seed three playlists and stub their URLs so the app boots into the channel
    // list without real network.
    async function seedThree(page: Page): Promise<void> {
      const stream = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:-1,\nhttp://streams.example.com/s.ts';
      await page.route('**/one.m3u8', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: stream }));
      await page.route('**/two.m3u8', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl', body: stream }));
      await page.route('**/four.m3u', r => r.fulfill({ status: 200, contentType: 'application/x-mpegurl',
        body: '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://streams.example.com/a\n#EXTINF:-1,Bravo\nhttp://streams.example.com/b' }));
      await page.addInitScript(() => {
        localStorage.setItem('iptv_playlists', JSON.stringify([
          { name: 'Playlist 1', url: 'http://host.example.com/one.m3u8', source: 'url', id: 'id1' },
          { name: 'Playlist 2', url: 'http://host.example.com/two.m3u8', source: 'url', id: 'id2' },
          { name: 'Playlist 4', url: 'http://host.example.com/four.m3u', source: 'url', id: 'id3' },
        ]));
      });
    }

    async function openSettings(page: Page): Promise<void> {
      await page.goto('/');
      await page.waitForSelector('.tab-bar-item[data-section="settings"]', { timeout: 20000 });
      await enterTab(page, 'settings');
      await page.waitForSelector('.remove-playlist');
    }

    const names = (page: Page) =>
      page.$$eval('.playlist-name', els => (els as HTMLInputElement[]).map(e => e.value));

    test('Remove deletes only the clicked row', async ({ page }) => {
      await seedThree(page);
      await openSettings(page);
      await page.locator('.remove-playlist').first().click();
      await page.waitForTimeout(200);
      expect(await names(page)).toEqual(['Playlist 2', 'Playlist 4']);
    });

    test('removing a middle row leaves the rest intact', async ({ page }) => {
      await seedThree(page);
      await openSettings(page);
      await page.locator('.remove-playlist').nth(1).click();
      await page.waitForTimeout(200);
      expect(await names(page)).toEqual(['Playlist 1', 'Playlist 4']);
    });

    test('deleting down to the last row clears it (no spurious re-add)', async ({ page }) => {
      // Removing the last row left focus on "+ Add Playlist"; the deferred select
      // then "clicked" it and re-added an empty row, so the last one never went.
      await seedThree(page);
      await openSettings(page);
      for (let i = 0; i < 3; i++) {
        await page.locator('.remove-playlist').first().click();
        await page.waitForTimeout(150);
      }
      await expect(page.locator('.playlist-name')).toHaveCount(0);
      await expect(page.locator('#playlist-entries .empty-hint')).toBeVisible();
    });
  });
});

test.describe('Settings Xtream: add -> cancel -> re-enter', () => {
  // Boot into the channel list (so the settings gear is present) with one M3U
  // playlist and NO Xtream account — matching "no Xtream account at all".
  async function seedOneM3u(page: Page): Promise<void> {
    await page.route('**/one.m3u', r => r.fulfill({
      status: 200, contentType: 'application/x-mpegurl',
      body: '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://streams.example.com/a',
    }));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([
        { name: 'Playlist 1', url: 'http://host.example.com/one.m3u', source: 'url', id: 'id1' },
      ]));
    });
  }

  async function openSettings(page: Page): Promise<void> {
    await page.waitForSelector('.tab-bar-item[data-section="settings"]', { timeout: 20000 });
    await enterTab(page, 'settings');
    await page.waitForSelector('#add-xtream');
  }

  test("re-entering Settings after Cancel must NOT show a leftover Xtream card", async ({ page }) => {
    await seedOneM3u(page);
    await page.goto('/');

    // 1) Open Settings — no Xtream account yet, no auto-added card.
    await openSettings(page);
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(0);
    await expect(page.locator('#xtream-entries .empty-hint')).toHaveText('No Xtream accounts added yet');

    // 2) Click "+ Add Xtream Account" — a blank card appears.
    await page.click('#add-xtream');
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(1);

    // 3) Cancel.
    await page.click('#cancel-settings');
    await liveLoaded(page); // back on channels

    // 4) Re-enter Settings.
    await openSettings(page);

    // 5) The card must be gone (this is the user's reported bug).
    await expect(page.locator('#xtream-entries .xtream-card')).toHaveCount(0);
    await expect(page.locator('#xtream-entries .empty-hint')).toHaveText('No Xtream accounts added yet');
  });
});

test.describe('Settings Xtream live output', () => {
  test('keeps long localized format labels aligned with the dropdown', async ({ page }) => {
    await page.route('**/get.php*', route => route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: '#EXTM3U',
    }));
    await page.route('**/xmltv.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
    await page.route('**/player_api.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1',
        name: 'Account 1',
        url: 'http://host.example.com:8080',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1' },
      }]));
    });

    await page.goto('/');
    for (const locale of ['en', 'de', 'es', 'fr', 'it', 'pt-BR', 'ru', 'uk', 'zh-CN']) {
      await page.evaluate((value) => {
        localStorage.setItem('iptv_locale', JSON.stringify(value));
      }, locale);
      await page.reload();
      await enterTab(page, 'settings');
      await page.locator('[data-settings-target="sources"]').click();

      const layout = await page.locator('.xtream-output').evaluate((field) => {
        const label = field.querySelector('label')!;
        const dropdown = field.querySelector('.dropdown')!;
        return {
          fieldWidth: field.getBoundingClientRect().width,
          labelWidth: label.getBoundingClientRect().width,
          labelHeight: label.getBoundingClientRect().height,
          labelLineHeight: parseFloat(getComputedStyle(label).lineHeight),
          dropdownWidth: dropdown.getBoundingClientRect().width,
        };
      });
      expect(layout.labelHeight, locale).toBeLessThanOrEqual(layout.labelLineHeight + 1);
      expect(layout.labelWidth, locale).toBeCloseTo(layout.fieldWidth, 0);
      expect(layout.dropdownWidth, locale).toBeCloseTo(layout.fieldWidth, 0);
      expect(layout.fieldWidth, locale).toBeLessThanOrEqual(260);
    }
  });

  test('saving HLS reloads the account with output=m3u8', async ({ page }) => {
    await page.route('**/get.php*', (route) => {
      const output = new URL(route.request().url()).searchParams.get('output');
      const channel = output === 'm3u8' ? 'HLS Channel' : 'TS Channel';
      return route.fulfill({
        status: 200,
        contentType: 'application/x-mpegurl',
        body: `#EXTM3U\n#EXTINF:-1,${channel}\nhttp://streams.example.com/live`,
      });
    });
    await page.route('**/xmltv.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
    await page.route('**/player_api.php*', (route) => {
      const action = new URL(route.request().url()).searchParams.get('action');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: action === 'get_live_streams'
          ? JSON.stringify([{
              stream_id: 101,
              direct_source: 'http://streams.example.com/live',
              tv_archive: 0,
            }])
          : '{}',
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1',
        name: 'Account 1',
        url: 'http://host.example.com:8080',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1' },
      }]));
    });

    await page.goto('/');
    await expect(page.locator('.channel-main .channel-item')).toContainText('TS Channel');
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.locator('#xtream-output-x1 .dropdown-trigger').click();
    await page.locator('#xtream-output-x1 [data-dropdown-value="m3u8"]').click();

    const hlsRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/get.php') && url.searchParams.get('output') === 'm3u8';
    });
    await page.locator('#save-settings').click();
    await hlsRequest;

    await liveLoaded(page);
    await expect(page.locator('.channel-main .channel-item')).toContainText('HLS Channel');
    await expect.poll(() => page.evaluate(() => {
      const playlists = JSON.parse(localStorage.getItem('iptv_playlists') || '[]');
      return playlists[0]?.xtream?.liveOutput;
    })).toBe('m3u8');
  });
});

test.describe('Settings Xtream live categories', () => {
  const CATEGORIES = [
    { category_id: 'c1', category_name: 'Group 1' },
    { category_id: 'c2', category_name: 'Group 2' },
    { category_id: 'c3', category_name: 'Group 3' },
  ];
  const STREAMS = [
    { stream_id: 101, name: 'Alpha', category_id: 'c1' },
    { stream_id: 102, name: 'Bravo', category_id: 'c2' },
    { stream_id: 103, name: 'Charlie', category_id: 'c3' },
  ];

  async function routeAccount(page: Page, categoryCount: () => number): Promise<void> {
    await page.route('**/get.php*', route => route.fulfill({
      status: 200,
      contentType: 'application/x-mpegurl',
      body: '#EXTM3U\n' + STREAMS.slice(0, categoryCount()).map(s =>
        `#EXTINF:-1 group-title="Group ${s.stream_id - 100}",${s.name}\n` +
        `http://host.example.com:8080/live/u1/p1/${s.stream_id}.ts`).join('\n'),
    }));
    await page.route('**/xmltv.php*', route =>
      route.fulfill({ status: 200, contentType: 'application/xml', body: '<tv></tv>' }));
    await page.route('**/player_api.php*', (route) => {
      const action = new URL(route.request().url()).searchParams.get('action');
      const body = action === 'get_live_streams'
        ? STREAMS.slice(0, categoryCount()).map(s => ({ ...s, direct_source: '', tv_archive: 0 }))
        : action === 'get_live_categories' ? CATEGORIES.slice(0, categoryCount()) : {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  }

  function seedAccount(page: Page, liveCategories?: unknown): Promise<void> {
    return page.addInitScript((filter) => {
      if (localStorage.getItem('iptv_playlists')) return;
      localStorage.setItem('iptv_playlists', JSON.stringify([{
        id: 'x1',
        name: 'Account 1',
        url: 'http://host.example.com:8080',
        source: 'xtream',
        xtream: { username: 'u1', password: 'p1', liveCategories: filter },
      }]));
    }, liveCategories);
  }

  const channels = (page: Page) => page.locator('.channel-main .channel-item');
  const press = (page: Page, keyCode: number) => page.evaluate(code => document.dispatchEvent(
    new KeyboardEvent('keydown', { keyCode: code, bubbles: true })), keyCode);

  test('choosing categories in the picker narrows the channel list after Save', async ({ page }) => {
    await routeAccount(page, () => 3);
    await seedAccount(page);
    await page.goto('/');
    await expect(channels(page)).toHaveCount(3);

    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    const button = page.locator('.xtream-card .xtream-live-categories');
    await expect(button).toContainText('All');
    await button.click();

    const picker = page.locator('.live-category-picker');
    await expect(picker.locator('[data-category-id]')).toHaveCount(3);
    await picker.locator('[data-key="all:c2"]').click();
    await expect(picker.locator('.live-category-row.favorite-selected')).toHaveCount(2);
    await press(page, 405);
    await expect(picker).toBeHidden();
    await expect(button).toContainText('2 of 3');

    await page.locator('#save-settings').click();
    await liveLoaded(page);
    await expect(channels(page)).toHaveCount(2);
    await expect(channels(page)).not.toContainText(['Bravo']);
    expect(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('iptv_playlists') || '[]')[0].xtream.liveCategories))
      .toEqual({ mode: 'include', ids: ['c1', 'c3'] });
  });

  test('after the pointer leaves, the first Down in the picker shows the row', async ({ page }) => {
    await routeAccount(page, () => 3);
    await seedAccount(page);
    await page.goto('/');
    await expect(channels(page)).toHaveCount(3);
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.locator('.xtream-card .xtream-live-categories').click();
    const picker = page.locator('.live-category-picker');
    const row = picker.locator('[data-key="all:c1"]');
    await expect(picker.locator('[data-category-id]')).toHaveCount(3);
    // Loading seeds focus; hover only after it, or the seed overrides the hover.
    await expect(picker.locator('.focused')).toHaveCount(1);
    // Park the real cursor the clicks left over the picker, or it hovers a row.
    await page.mouse.move(0, 0);
    await row.evaluate((node) => {
      node.dispatchEvent(new CustomEvent('nav:hover', { bubbles: true }));
      node.dispatchEvent(new CustomEvent('nav:unhover', { bubbles: true }));
    });
    await expect(picker.locator('.focused')).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await expect(row).toHaveClass(/\bfocused\b/);
    await page.keyboard.press('ArrowDown');
    await expect(row).not.toHaveClass(/\bfocused\b/);
  });

  test('the picker switches accounts after applying the current one', async ({ page }) => {
    await routeAccount(page, () => 3);
    await page.addInitScript(() => {
      if (localStorage.getItem('iptv_playlists')) return;
      localStorage.setItem('iptv_playlists', JSON.stringify(['1', '2'].map(n => ({
        id: `x${n}`,
        name: `Account ${n}`,
        url: `http://host.example.com:808${n}`,
        source: 'xtream',
        xtream: { username: `u${n}`, password: `p${n}` },
      }))));
    });
    await page.goto('/');
    await expect(channels(page)).toHaveCount(3);
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.locator('.xtream-card[data-id="x1"] .xtream-live-categories').click();

    const picker = page.locator('.live-category-picker');
    await expect(picker.locator('[data-category-id]')).toHaveCount(3);
    await expect(picker.locator('.live-category-account-name')).toHaveText('Account 1');
    // The heading rule stops at the list's scrollbar.
    const [rule, list] = await Promise.all([
      picker.locator('.live-category-heading').boundingBox(),
      picker.locator('.live-category-list').boundingBox(),
    ]);
    expect(Math.abs(rule!.x + rule!.width - (list!.x + list!.width))).toBeLessThan(1);

    await picker.locator('[data-key="all:c2"]').click();
    await picker.locator('.account-avatar').click();
    await picker.locator('.account-menu-item[data-account-id="x2"]').click();
    await expect(picker.locator('.live-category-account-name')).toHaveText('Account 2');
    await expect(picker.locator('.live-category-row.favorite-selected')).toHaveCount(3);
    await expect(page.locator('.xtream-card[data-id="x1"] .xtream-live-categories'))
      .toContainText('2 of 3');

    await press(page, 405);
    await expect(picker).toBeHidden();
    await expect(page.locator('.xtream-card[data-id="x2"] .xtream-live-categories'))
      .toHaveClass(/focused/);
  });

  test('the pointer on the picker account menu keeps one ring, and Back returns to the avatar', async ({ page }) => {
    await routeAccount(page, () => 3);
    await page.addInitScript(() => {
      if (localStorage.getItem('iptv_playlists')) return;
      localStorage.setItem('iptv_playlists', JSON.stringify(['1', '2'].map(n => ({
        id: `x${n}`,
        name: `Account ${n}`,
        url: `http://host.example.com:808${n}`,
        source: 'xtream',
        xtream: { username: `u${n}`, password: `p${n}` },
      }))));
    });
    await page.goto('/');
    await expect(channels(page)).toHaveCount(3);
    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    await page.locator('.xtream-card[data-id="x1"] .xtream-live-categories').click();
    const picker = page.locator('.live-category-picker');
    await expect(picker.locator('[data-category-id]')).toHaveCount(3);
    const hover = async (target: Locator) => {
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };

    await picker.locator('.account-avatar').click();
    await expect(picker.locator('.account-menu')).toBeVisible();
    // The pointer crosses the list on its way back to the menu.
    const row = picker.locator('[data-key="all:c3"]');
    await hover(row);
    await expect(row).toHaveClass(/\bfocused\b/);
    const second = picker.locator('.account-menu-item[data-account-id="x2"]');
    await hover(second);
    await expect(second).toHaveClass(/\bfocused\b/);
    await expect(picker.locator('.focused:not(.live-category-account-slot)')).toHaveCount(1);

    await press(page, 461);
    await expect(picker.locator('.account-menu')).toHaveCount(0);
    await expect(picker).toBeVisible();
    await expect(picker.locator('.account-avatar')).toHaveClass(/\bfocused\b/);
    await expect(picker.locator('.focused:not(.live-category-account-slot)')).toHaveCount(1);
  });

  test('a new provider category stays hidden and is announced once', async ({ page }) => {
    let count = 2;
    await routeAccount(page, () => count);
    await seedAccount(page, { mode: 'include', ids: ['c1'] });
    // Paper Light has the weakest accent and status colors on its fills.
    await page.addInitScript(() => localStorage.setItem('iptv_theme', JSON.stringify('paper-light')));
    await page.goto('/');
    await expect(channels(page)).toHaveCount(1);
    // The first load only records the categories it saw.
    await expect.poll(async () => (await readUserDataStore<{ knownIds: string[] }>(page, 'channel-state'))
      .find(record => record.key === 'live-categories:x1')?.value.knownIds)
      .toEqual(['c1', 'c2']);

    count = 3;
    await page.reload();
    await expect(channels(page)).toHaveCount(1);
    await expect(page.locator('.toast.visible')).toContainText('Account 1: 1 new live category', { timeout: 10000 });

    await enterTab(page, 'settings');
    await page.locator('[data-settings-target="sources"]').click();
    const button = page.locator('.xtream-card .xtream-live-categories');
    await expect(button.locator('.xtream-live-categories-new')).toHaveText('1 new');
    const textColor = (locator: Locator) => locator.evaluate(el => getComputedStyle(el).color);
    // Text contrast against the element's own fill, which the badge has.
    const ownContrast = (locator: Locator) => locator.evaluate(el => {
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: number[]) => c.map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const style = getComputedStyle(el);
      if (style.backgroundColor === 'rgba(0, 0, 0, 0)') return 0;
      const [a, b] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    const badge = button.locator('.xtream-live-categories-new');
    expect(await ownContrast(badge)).toBeGreaterThanOrEqual(4.5);
    expect(await textColor(button.locator('.xtream-live-categories-value'))).toBe(await textColor(button));
    expect(await button.locator('.xtream-live-categories-value').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    await button.click();
    const picker = page.locator('.live-category-picker');
    const newRow = picker.locator('[data-key="new:c3"]');
    await expect(newRow.locator('.live-category-new')).toBeVisible();
    expect(await ownContrast(newRow.locator('.live-category-new'))).toBeGreaterThanOrEqual(4.5);
    await press(page, 461);
    await expect(picker).toBeHidden();
    await expect(button.locator('.xtream-live-categories-new')).toHaveCount(0);
  });
});

test.describe('Settings upload', () => {
  test('Settings shows an uploaded playlist after a serviceEvents upload notification', async ({ page }) => {
    // End-to-end coverage for the push-driven upload refresh flow:
    //   service POST /uploads succeeds → service broadcasts Luna `serviceEvents`
    //   → app's subscription onSuccess fires → settings.refreshUploads() →
    //   UploadClient.reconcile() → fetch /uploads → storage write → morph().
    //
    // Playwright can't drive a real Luna bus, so we fake PalmServiceBridge
    // in an init script (captures the serviceEvents onSuccess so the test can
    // synthesize a push) and route the in-app HTTP fetches to a small
    // mutable fixture. Everything else — Settings render, UploadClient,
    // StorageService, morph, focus — runs as real production code.

    // Mutable fixture for /uploads responses. The route handler reads this
    // closure on every fetch, so test mutations are picked up by subsequent
    // reconcile calls.
    type UploadItem = { id: string; name: string; count: number; createdAt: number; url: string };
    let uploads: UploadItem[] = [];

    await page.route('http://127.0.0.1:9999/uploads', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(uploads),
      }),
    );
    await page.route('http://127.0.0.1:9999/info', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ip: '192.168.1.2',
          port: 9999,
          setupUrl: 'http://192.168.1.2:9999/setup?token=abc123',
          manualUrl: 'http://192.168.1.2:9999',
          pairingCode: '1234',
        }),
      }),
    );
    await page.route('http://127.0.0.1:9999/setup-state', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"updated":true}',
      }),
    );

    // Fake PalmServiceBridge — installed before the app bundle runs.
    await page.addInitScript(() => {
      type Cb = (resp: unknown) => void;
      const win = window as unknown as {
        PalmServiceBridge?: unknown;
        __eventCallbacks__?: Cb[];
        __triggerUploadPush__?: (data?: unknown) => void;
      };
      win.__eventCallbacks__ = [];
      win.__triggerUploadPush__ = (data?: unknown) => {
        for (const cb of win.__eventCallbacks__!) cb(data ?? { event: 'uploads-changed' });
      };
      class FakePalmServiceBridge {
        onservicecallback: ((message: string) => void) | null = null;

        private respond(response: unknown): void {
          setTimeout(() => this.onservicecallback?.(JSON.stringify(response)), 0);
        }

        call(uri: string): void {
          const method = uri.slice(uri.lastIndexOf('/') + 1);
          if (method === 'start') {
            // The real service returns the bound port; the in-app client
            // (UploadClient) uses this for all subsequent fetches.
            this.respond({ running: true, port: 9999 });
          } else if (method === 'serviceEvents') {
            // Initial subscription ack (matches the real service's first
            // respond({subscribed:true}) inside the serviceEvents handler).
            this.respond({ subscribed: true });
            win.__eventCallbacks__!.push((response) => {
              this.onservicecallback?.(JSON.stringify(response));
            });
          } else {
            // Unknown method — surface as a failure so future Luna additions
            // that we forget to mock here will fail the test loudly.
            this.respond({ returnValue: false, errorText: 'unmocked method: ' + method });
          }
        }

        cancel(): void {
          this.onservicecallback = null;
        }
      }
      win.PalmServiceBridge = FakePalmServiceBridge;
    });

    await seedPlaylist(page);
    await page.goto('/');

    // Boots into channels from the seeded URL playlist.
    await liveLoaded(page);

    // Open settings via the tab bar; the upload list starts empty.
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await expect(page.locator('#upload-entries .empty-hint')).toHaveText('No uploaded playlists');

    // Simulate a phone POSTing a playlist to the service: mutate the routed
    // response, then fire the push the service would send on POST success.
    uploads = [{
      id: 'channel-one', name: 'Channel One', count: 2, createdAt: Date.now(),
      url: 'http://127.0.0.1:9999/uploads/channel-one.m3u',
    }];
    await page.evaluate(() => (window as unknown as { __triggerUploadPush__: () => void }).__triggerUploadPush__());

    // Settings re-morphs #upload-entries from the new /uploads response. No
    // navigation, no manual refresh. Label appends the channel count from the
    // UploadMeta (see uploadLabel() in settings.ts).
    const row = page.locator('#upload-entries .settings-row');
    await expect(row).toHaveCount(1);
    await expect(row.locator('label')).toHaveText('Channel One — 2 channels');
    await expect(page.locator('#upload-entries .empty-hint')).toHaveCount(0);

    // Storage was updated too: source: 'upload' entry is persisted.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('iptv_playlists') || '[]'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Channel One', source: 'upload' }),
      ]),
    );

    // A second push that drops the upload also flows through (covers the
    // "delete in the setup page's M3U section" case → DELETE /uploads/:id fires
    // onChange too).
    uploads = [];
    await page.evaluate(() => (window as unknown as { __triggerUploadPush__: () => void }).__triggerUploadPush__());
    await expect(page.locator('#upload-entries .settings-row')).toHaveCount(0);
    await expect(page.locator('#upload-entries .empty-hint')).toBeVisible();
  });
});

test.describe('Settings phone setup card', () => {
  // The QR sits beside its instructions via flex `gap`, so on webOS the spacing
  // comes entirely from the generated margin fallback. Under the
  // `chromium-53-simulation` project this is the regression guard for that
  // generator: a dropped rule collapses the gap to 0 and knocks the text out
  // of alignment.
  test('keeps the QR spaced from its instructions', async ({ page }) => {
    await page.addInitScript(() => {
      class FakePalmServiceBridge {
        onservicecallback: ((message: string) => void) | null = null;

        call(uri: string): void {
          const method = uri.slice(uri.lastIndexOf('/') + 1);
          const response = method === 'start'
            ? { returnValue: true, port: 8890 }
            : { returnValue: true };
          this.onservicecallback?.(JSON.stringify(response));
        }

        cancel(): void {
          this.onservicecallback = null;
        }
      }
      (window as unknown as {
        PalmServiceBridge?: unknown;
      }).PalmServiceBridge = FakePalmServiceBridge;
    });
    await page.route('http://127.0.0.1:8890/info', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ip: '10.0.0.2',
        port: 8890,
        setupUrl: 'http://10.0.0.2:8890/setup',
        manualUrl: 'http://10.0.0.2:8890',
        pairingCode: '123456',
      }),
    }));

    await page.goto('/');
    await page.locator('[data-settings-target="general"]').click();
    await expect(page.locator('.setup-qr')).toBeVisible();

    const layout = await page.evaluate(() => {
      const qr = document.querySelector('.setup-qr')!.getBoundingClientRect();
      const text = document.querySelector('.setup-instructions')!.getBoundingClientRect();
      return {
        gap: Math.round(text.left - qr.right),
        centerOffset: Math.round((text.top + text.height / 2) - (qr.top + qr.height / 2)),
      };
    });

    expect(layout.gap).toBe(24);
    expect(layout.centerOffset).toBe(0);
  });
});
