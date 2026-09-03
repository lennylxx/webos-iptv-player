import { test, expect, type Page, routePlaylist, seedPlaylist, PLAYLIST_URL, enterTab } from './helpers';

// All Settings coverage: navigation, playlist save/removal, Xtream, and uploads.

test.describe('Settings navigation', () => {
  test('the Settings tab on the channel list opens settings', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);

    await page.goto('/');
    await expect(page.locator('#view-channels')).toBeVisible();

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
    await expect(page.locator('#view-channels')).toBeVisible();

    // Open settings via the tab bar, then dismiss with Cancel.
    await enterTab(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('#cancel-settings').click();

    // Give the document-level deferred select (setTimeout 0) a chance to fire,
    // then assert we still land on the channel list rather than the player.
    // Before the fix, that second select fired on the channels view and played
    // the focused channel.
    await page.waitForTimeout(50);
    await expect(page.locator('#view-channels')).toBeVisible();
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
      return title.top >= main.top && title.bottom <= main.bottom;
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

    await expect(page.locator('#epg-url')).toHaveClass(/focused/);
    await expect(guide).toHaveClass(/active/);
  });

  test('Left returns from a category content boundary to its sidebar item', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#view-settings')).toBeVisible();

    const guide = page.locator('[data-settings-target="guide"]');
    await guide.dispatchEvent('nav:hover');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#epg-url')).toHaveClass(/focused/);

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
    await expect(page.locator('#view-channels')).toBeVisible();

    // Persisted across a relaunch and applied outside Settings, without
    // changing the dimensions of controls.
    await page.reload();
    await expect(page.locator('#view-channels')).toBeVisible();
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
    await expect(page.locator('#view-channels')).toBeVisible();
    const unscaled = await metrics();
    expect(scaled.font).toBeCloseTo(unscaled.font * 1.3, 1);
    for (const key of ['height', 'padding', 'logo'] as const)
      expect(scaled[key], key).toBeCloseTo(unscaled[key], 1);
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

    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel One' })).toBeVisible();
    await expect(page.locator('.channel-main .channel-name').filter({ hasText: 'Channel Two' })).toBeVisible();
  });

  test('removing the last playlist clears in-memory channels so back returns an empty list', async ({ page }) => {
    await routePlaylist(page);
    await seedPlaylist(page);
    await page.goto('/');

    // Channels render from the configured playlist.
    await expect(page.locator('#view-channels')).toBeVisible();
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
    await expect(page.locator('#view-channels')).toBeVisible();
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
    await expect(page.locator('#view-channels')).toBeVisible(); // back on channels

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
        body: action === 'get_live_streams' ? '[]' : '{}',
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

    await expect(page.locator('#view-channels')).toBeVisible();
    await expect(page.locator('.channel-main .channel-item')).toContainText('HLS Channel');
    await expect.poll(() => page.evaluate(() => {
      const playlists = JSON.parse(localStorage.getItem('iptv_playlists') || '[]');
      return playlists[0]?.xtream?.liveOutput;
    })).toBe('m3u8');
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
    await expect(page.locator('#view-channels')).toBeVisible();

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
