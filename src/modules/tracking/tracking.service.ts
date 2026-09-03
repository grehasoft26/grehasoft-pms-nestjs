import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // 1. GET OR CREATE USER TRACKING PROFILE
  // -------------------------------------------------------------
  async getOrCreateProfile(userId: number) {
    let profile = await this.prisma.trackingUserProfile.findUnique({
      where: { user_id: userId },
    });

    if (!profile) {
      profile = await this.prisma.trackingUserProfile.create({
        data: {
          user_id: userId,
          is_tracking_enabled: true,
          screenshots_enabled: true,
        },
      });
    }

    return profile;
  }

  async setTrackingEnabled(userId: number, enabled: boolean) {
    const profile = await this.getOrCreateProfile(userId);

    const updated = await this.prisma.trackingUserProfile.update({
      where: { id: profile.id },
      data: { is_tracking_enabled: enabled },
    });

    return {
      success: true,
      message: `Tracking ${enabled ? 'enabled' : 'disabled'} successfully`,
      data: updated,
    };
  }

  async toggleTrackingForUser(adminUser: any, targetUserId: number, enabled?: boolean) {
    const profile = await this.getOrCreateProfile(targetUserId);
    const newStatus = enabled !== undefined ? enabled : !profile.is_tracking_enabled;

    const updated = await this.prisma.trackingUserProfile.update({
      where: { id: profile.id },
      data: { is_tracking_enabled: newStatus },
    });

    return {
      success: true,
      message: `Tracking ${newStatus ? 'enabled' : 'disabled'} for user ID ${targetUserId}`,
      data: updated,
    };
  }

  classifyAppActivity(appName: string = '', windowTitle: string = ''): 'productive' | 'non_productive' {
    const appLower = (appName || '').toLowerCase().trim();
    const titleLower = (windowTitle || '').toLowerCase();

    if (!appLower || appLower === 'idle' || appLower === 'none') {
      return 'non_productive';
    }

    const nonProductiveApps = [
      'youtube', 'facebook', 'twitter', 'instagram', 'netflix', 'spotify',
      'reddit', 'pinterest', 'tumblr', 'tiktok', 'vimeo', 'solitaire',
      'freecell', 'minesweeper', 'steam', 'epic games', 'origin', 'uplay',
      'discord', 'twitch', 'hulu', 'disney+', 'games', 'game'
    ];

    for (const np of nonProductiveApps) {
      if (appLower.includes(np)) return 'non_productive';
    }

    if (['chrome', 'firefox', 'safari', 'edge', 'opera', 'browser'].some((b) => appLower.includes(b))) {
      const nonProductiveSites = ['youtube.com', 'facebook.com', 'twitter.com', 'instagram.com', 'netflix.com', 'reddit.com', 'pinterest.com', 'amazon.in', 'amazon.com', 'flipkart.com', 'ebay.com'];
      for (const site of nonProductiveSites) {
        if (titleLower.includes(site) || titleLower.includes(site.split('.')[0])) {
          return 'non_productive';
        }
      }
    }

    return 'productive';
  }

  // -------------------------------------------------------------
  // 2. HEARTBEAT & SESSION MANAGEMENT
  // -------------------------------------------------------------
  async handleHeartbeat(userId: number, body: any = {}) {
    const profile = await this.getOrCreateProfile(userId);
    if (!profile.is_tracking_enabled) {
      throw new ForbiddenException('Tracking is disabled for user');
    }

    const now = new Date();
    const deviceId = body?.device_id || 'default';
    const installationUuid = body?.installation_uuid || null;
    const trackerId = body?.tracker_id || null;
    const machineFingerprint = body?.machine_fingerprint || null;

    let eventTime = now;
    if (body?.timestamp) {
      const parsed = new Date(body.timestamp);
      if (!isNaN(parsed.getTime()) && parsed.getTime() <= now.getTime() + 60 * 1000) {
        eventTime = parsed;
      }
    }

    let activeSession: any = null;

    if (deviceId === 'default') {
      const activeDesktopSession = await this.prisma.workSession.findFirst({
        where: {
          user_id: userId,
          is_active_session: true,
          NOT: { device_id: 'default' },
        },
        orderBy: { login_time: 'desc' },
      });

      if (activeDesktopSession) {
        const timeSinceDesktopMs = now.getTime() - new Date(activeDesktopSession.last_ping).getTime();
        if (timeSinceDesktopMs > 5 * 60 * 1000) {
          await this.prisma.workSession.update({
            where: { id: activeDesktopSession.id },
            data: {
              is_active_session: false,
              logout_time: activeDesktopSession.last_ping,
            },
          });
        } else {
          activeSession = activeDesktopSession;
        }
      }
    } else {
      const otherActiveSessions = await this.prisma.workSession.findMany({
        where: {
          user_id: userId,
          is_active_session: true,
          NOT: { device_id: deviceId },
        },
      });

      for (const oldSess of otherActiveSessions) {
        await this.prisma.workSession.update({
          where: { id: oldSess.id },
          data: {
            is_active_session: false,
            logout_time: oldSess.last_ping || oldSess.login_time || now,
          },
        });
      }
    }

    if (!activeSession) {
      activeSession = await this.prisma.workSession.findFirst({
        where: {
          user_id: userId,
          device_id: deviceId,
          is_active_session: true,
        },
        orderBy: { login_time: 'desc' },
      });
    }

    if (activeSession) {
      const timeSincePingMs = now.getTime() - new Date(activeSession.last_ping).getTime();
      if (timeSincePingMs > 5 * 60 * 1000) {
        await this.prisma.workSession.update({
          where: { id: activeSession.id },
          data: {
            is_active_session: false,
            logout_time: activeSession.last_ping,
          },
        });

        activeSession = await this.prisma.workSession.create({
          data: {
            user_id: userId,
            login_time: eventTime < now ? eventTime : now,
            last_ping: now,
            is_active_session: true,
            device_id: deviceId,
            installation_uuid: installationUuid,
            tracker_id: trackerId,
            machine_fingerprint: machineFingerprint,
          },
        });
      } else {
        activeSession = await this.prisma.workSession.update({
          where: { id: activeSession.id },
          data: {
            last_ping: now,
            installation_uuid: installationUuid || activeSession.installation_uuid,
            tracker_id: trackerId || activeSession.tracker_id,
            machine_fingerprint: machineFingerprint || activeSession.machine_fingerprint,
          },
        });
      }
    } else {
      activeSession = await this.prisma.workSession.create({
        data: {
          user_id: userId,
          login_time: eventTime < now ? eventTime : now,
          last_ping: now,
          is_active_session: true,
          device_id: deviceId,
          installation_uuid: installationUuid,
          tracker_id: trackerId,
          machine_fingerprint: machineFingerprint,
        },
      });
    }

    const appName = body?.app_name || body?.current_app || null;
    const windowTitle = body?.window_title || body?.current_window || '';
    const durationSeconds = Number(body?.duration_seconds || 10);
    const isIdle = Boolean(body?.is_idle || false);
    const mouseMoves = Number(body?.mouse_moves || 0);
    const keyPresses = Number(body?.key_presses || 0);
    const clicks = Number(body?.clicks || 0);

    const isDesktopTelemetry = (deviceId !== 'default') || (appName !== null) || (mouseMoves > 0 || keyPresses > 0 || clicks > 0);

    if (isDesktopTelemetry) {
      // Always update live idle status & last desktop ping on active session
      activeSession = await this.prisma.workSession.update({
        where: { id: activeSession.id },
        data: {
          last_desktop_ping: now,
          is_desktop_idle: isIdle,
        },
      });

      // Application-level deduplication: check if exact identical app activity was recorded in last 3 seconds
      const recentDup = await this.prisma.appActivity.findFirst({
        where: {
          session_id: activeSession.id,
          app_name: appName || 'Active Workspace',
          window_title: windowTitle,
          timestamp: { gte: new Date(eventTime.getTime() - 2000), lte: new Date(eventTime.getTime() + 2000) },
        },
      });

      if (!recentDup) {
        const category = this.classifyAppActivity(appName || '', windowTitle);
        const isProductiveTick = (!isIdle) && (mouseMoves > 0 || keyPresses > 0 || clicks > 0);
        const tickProductiveSeconds = isProductiveTick ? durationSeconds : 0;
        const tickIdleSeconds = isProductiveTick ? 0 : durationSeconds;

        const updatedMouse = activeSession.mouse_moves + mouseMoves;
        const updatedKeys = activeSession.key_presses + keyPresses;
        const updatedClicks = activeSession.clicks + clicks;
        const updatedProd = activeSession.productive_seconds + tickProductiveSeconds;
        const updatedIdle = activeSession.idle_seconds + tickIdleSeconds;
        const updatedTracked = updatedProd + updatedIdle;
        const activityPct = updatedTracked > 0 ? Math.min(100.0, (updatedProd / updatedTracked) * 100.0) : 0.0;

        activeSession = await this.prisma.workSession.update({
          where: { id: activeSession.id },
          data: {
            mouse_moves: updatedMouse,
            key_presses: updatedKeys,
            clicks: updatedClicks,
            productive_seconds: updatedProd,
            idle_seconds: updatedIdle,
            tracked_seconds: updatedTracked,
            activity_percentage: activityPct,
          },
        });

        if (appName) {
          const lastActivity = await this.prisma.appActivity.findFirst({
            where: { session_id: activeSession.id },
            orderBy: { timestamp: 'desc' },
          });

          if (lastActivity && lastActivity.app_name === appName && lastActivity.window_title === windowTitle) {
            await this.prisma.appActivity.update({
              where: { id: lastActivity.id },
              data: {
                duration_seconds: lastActivity.duration_seconds + durationSeconds,
                mouse_moves: lastActivity.mouse_moves + mouseMoves,
                key_presses: lastActivity.key_presses + keyPresses,
                clicks: lastActivity.clicks + clicks,
                productive_seconds: lastActivity.productive_seconds + tickProductiveSeconds,
                productive_duration: lastActivity.productive_duration + tickProductiveSeconds,
                timestamp: eventTime,
              },
            });
          } else {
            await this.prisma.appActivity.create({
              data: {
                user_id: userId,
                session_id: activeSession.id,
                app_name: appName,
                window_title: windowTitle,
                duration_seconds: durationSeconds,
                mouse_moves: mouseMoves,
                key_presses: keyPresses,
                clicks: clicks,
                productive_seconds: tickProductiveSeconds,
                productive_duration: tickProductiveSeconds,
                timestamp: eventTime,
                is_productive: category === 'productive',
              },
            });
          }
        }
      }
    }

    return {
      success: true,
      message: 'Heartbeat recorded',
      session_id: activeSession.id,
      status: isIdle ? 'Idle' : 'Active',
    };
  }

  async handleActivityBatchSync(userId: number, body: any = {}) {
    const profile = await this.getOrCreateProfile(userId);
    if (!profile.is_tracking_enabled) {
      throw new ForbiddenException('Tracking is disabled for user');
    }

    const now = new Date();
    const deviceId = body?.device_id || 'default';
    const installationUuid = body?.installation_uuid || null;
    const trackerId = body?.tracker_id || null;
    const machineFingerprint = body?.machine_fingerprint || null;
    const rawActivities = Array.isArray(body?.activities) ? body.activities : [];

    if (rawActivities.length === 0) {
      return {
        success: true,
        synced_count: 0,
        skipped_count: 0,
        message: 'No activities to sync',
      };
    }

    const parsedActivities = [];
    for (const item of rawActivities) {
      if (!item || typeof item !== 'object') continue;
      const appName = item.app_name || item.current_app;
      if (!appName) continue;

      let ts = now;
      if (item.timestamp) {
        const p = new Date(item.timestamp);
        if (!isNaN(p.getTime()) && p.getTime() <= now.getTime() + 60 * 1000) {
          ts = p;
        }
      }

      parsedActivities.push({
        app_name: String(appName),
        window_title: item.window_title || item.current_window || '',
        duration_seconds: Math.max(1, Number(item.duration_seconds || 10)),
        is_idle: Boolean(item.is_idle || false),
        mouse_moves: Math.max(0, Number(item.mouse_moves || 0)),
        key_presses: Math.max(0, Number(item.key_presses || 0)),
        clicks: Math.max(0, Number(item.clicks || 0)),
        timestamp: ts,
      });
    }

    parsedActivities.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (parsedActivities.length === 0) {
      return {
        success: true,
        synced_count: 0,
        skipped_count: 0,
        message: 'No valid activities in batch',
      };
    }

    const firstTs = parsedActivities[0].timestamp;
    const lastTs = parsedActivities[parsedActivities.length - 1].timestamp;

    const isHistorical = (now.getTime() - lastTs.getTime()) > 5 * 60 * 1000;
    let targetSession: any = null;

    if (isHistorical) {
      targetSession = await this.prisma.workSession.findFirst({
        where: {
          user_id: userId,
          device_id: deviceId,
          login_time: { lte: lastTs },
          logout_time: { gte: firstTs },
        },
        orderBy: { login_time: 'desc' },
      });

      if (!targetSession) {
        targetSession = await this.prisma.workSession.create({
          data: {
            user_id: userId,
            login_time: firstTs,
            last_ping: lastTs,
            logout_time: lastTs,
            is_active_session: false,
            device_id: deviceId,
            installation_uuid: installationUuid,
            tracker_id: trackerId,
            machine_fingerprint: machineFingerprint,
          },
        });
      }
    } else {
      targetSession = await this.prisma.workSession.findFirst({
        where: {
          user_id: userId,
          device_id: deviceId,
          is_active_session: true,
        },
        orderBy: { login_time: 'desc' },
      });

      if (!targetSession) {
        targetSession = await this.prisma.workSession.create({
          data: {
            user_id: userId,
            login_time: firstTs,
            last_ping: now,
            is_active_session: true,
            device_id: deviceId,
            installation_uuid: installationUuid,
            tracker_id: trackerId,
            machine_fingerprint: machineFingerprint,
          },
        });
      } else {
        await this.prisma.workSession.update({
          where: { id: targetSession.id },
          data: { last_ping: now },
        });
      }
    }

    let syncedCount = 0;
    let skippedCount = 0;
    let totalMouse = 0;
    let totalKeys = 0;
    let totalClicks = 0;
    let totalProdSec = 0;
    let totalIdleSec = 0;

    for (const act of parsedActivities) {
      const existing = await this.prisma.appActivity.findFirst({
        where: {
          session_id: targetSession.id,
          app_name: act.app_name,
          window_title: act.window_title,
          timestamp: act.timestamp,
        },
      });

      if (existing) {
        skippedCount++;
        continue;
      }

      const category = this.classifyAppActivity(act.app_name, act.window_title);
      const isProductiveTick = (!act.is_idle) && (act.mouse_moves > 0 || act.key_presses > 0 || act.clicks > 0);
      const tickProd = isProductiveTick ? act.duration_seconds : 0;
      const tickIdle = isProductiveTick ? 0 : act.duration_seconds;

      totalMouse += act.mouse_moves;
      totalKeys += act.key_presses;
      totalClicks += act.clicks;
      totalProdSec += tickProd;
      totalIdleSec += tickIdle;

      const lastAct = await this.prisma.appActivity.findFirst({
        where: { session_id: targetSession.id },
        orderBy: { timestamp: 'desc' },
      });

      if (lastAct && lastAct.app_name === act.app_name && lastAct.window_title === act.window_title) {
        await this.prisma.appActivity.update({
          where: { id: lastAct.id },
          data: {
            duration_seconds: lastAct.duration_seconds + act.duration_seconds,
            mouse_moves: lastAct.mouse_moves + act.mouse_moves,
            key_presses: lastAct.key_presses + act.key_presses,
            clicks: lastAct.clicks + act.clicks,
            productive_seconds: lastAct.productive_seconds + tickProd,
            productive_duration: lastAct.productive_duration + tickProd,
            timestamp: act.timestamp,
          },
        });
      } else {
        await this.prisma.appActivity.create({
          data: {
            user_id: userId,
            session_id: targetSession.id,
            app_name: act.app_name,
            window_title: act.window_title,
            duration_seconds: act.duration_seconds,
            mouse_moves: act.mouse_moves,
            key_presses: act.key_presses,
            clicks: act.clicks,
            productive_seconds: tickProd,
            productive_duration: tickProd,
            timestamp: act.timestamp,
            is_productive: category === 'productive',
          },
        });
      }

      syncedCount++;
    }

    const currentSession = await this.prisma.workSession.findUnique({ where: { id: targetSession.id } });
    if (currentSession && syncedCount > 0) {
      const newProd = currentSession.productive_seconds + totalProdSec;
      const newIdle = currentSession.idle_seconds + totalIdleSec;
      const newTracked = newProd + newIdle;
      const newPct = newTracked > 0 ? Math.min(100.0, (newProd / newTracked) * 100.0) : 0.0;

      await this.prisma.workSession.update({
        where: { id: targetSession.id },
        data: {
          mouse_moves: currentSession.mouse_moves + totalMouse,
          key_presses: currentSession.key_presses + totalKeys,
          clicks: currentSession.clicks + totalClicks,
          productive_seconds: newProd,
          idle_seconds: newIdle,
          tracked_seconds: newTracked,
          activity_percentage: newPct,
        },
      });
    }

    return {
      success: true,
      synced_count: syncedCount,
      skipped_count: skippedCount,
      session_id: targetSession.id,
      message: `Batch sync complete. Synced: ${syncedCount}, Skipped duplicates: ${skippedCount}`,
    };
  }

  async handleLogout(userId: number) {
    const activeSession = await this.prisma.workSession.findFirst({
      where: {
        user_id: userId,
        is_active_session: true,
      },
      orderBy: { login_time: 'desc' },
    });

    if (activeSession) {
      const now = new Date();
      await this.prisma.workSession.update({
        where: { id: activeSession.id },
        data: {
          is_active_session: false,
          logout_time: now,
          last_ping: now,
        },
      });

      return {
        success: true,
        message: 'Session ended successfully',
        session_id: activeSession.id,
      };
    }

    return {
      success: true,
      message: 'No active session found',
      session_id: null,
    };
  }

  // -------------------------------------------------------------
  // 3. EMPLOYEE STATUS SUMMARY
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // 3. EMPLOYEE STATUS SUMMARY
  // -------------------------------------------------------------
  async getEmployeeStatus(targetUserId?: number) {
    const where: any = {};
    if (targetUserId) where.id = targetUserId;

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        tracking_profile: true,
      },
    });

    const now = new Date();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const results = [];

    for (const u of users) {
      let activeSession = await this.prisma.workSession.findFirst({
        where: { user_id: u.id, is_active_session: true },
        orderBy: { login_time: 'desc' },
      });

      let displaySession = activeSession;
      if (!displaySession) {
        displaySession = await this.prisma.workSession.findFirst({
          where: { user_id: u.id },
          orderBy: { last_ping: 'desc' },
        });
      }

      const firstSession = await this.prisma.workSession.findFirst({
        where: { user_id: u.id, login_time: { gte: todayStart } },
        orderBy: { login_time: 'asc' },
      });

      let status = 'Offline';
      let isLive = false;

      if (activeSession && activeSession.is_active_session) {
        if (activeSession.last_desktop_ping) {
          const secondsDesktop = Math.floor((now.getTime() - new Date(activeSession.last_desktop_ping).getTime()) / 1000);
          if (secondsDesktop <= 300) {
            isLive = true;
            if (activeSession.is_desktop_idle || secondsDesktop > 120) {
              status = 'Idle';
            } else {
              status = 'Active';
            }
          }
        }

        if (!isLive && activeSession.last_ping) {
          const secondsPing = Math.floor((now.getTime() - new Date(activeSession.last_ping).getTime()) / 1000);
          if (secondsPing <= 300) {
            isLive = true;
            status = 'Active';
          }
        }
      }

      let loginTime: string | null = null;
      let lastPing: string | null = null;
      let currentApp: string | null = null;
      let currentWindow: string | null = null;

      let productiveSeconds = 0;
      let idleSeconds = 0;
      let mouseMoves = 0;
      let keyPresses = 0;
      let clicks = 0;

      if (displaySession) {
        lastPing = displaySession.last_ping ? displaySession.last_ping.toISOString() : null;
        productiveSeconds = displaySession.productive_seconds || 0;
        idleSeconds = displaySession.idle_seconds || 0;
        mouseMoves = displaySession.mouse_moves || 0;
        keyPresses = displaySession.key_presses || 0;
        clicks = displaySession.clicks || 0;
      }

      if (isLive && activeSession) {
        loginTime = activeSession.login_time.toISOString();

        const latestAct = await this.prisma.appActivity.findFirst({
          where: { session_id: activeSession.id },
          orderBy: { timestamp: 'desc' },
        });

        if (latestAct) {
          currentApp = latestAct.app_name;
          currentWindow = latestAct.window_title;
        }
      }

      const trackedSeconds = productiveSeconds + idleSeconds;
      const activityPct = trackedSeconds > 0 ? Math.min(100.0, (productiveSeconds / trackedSeconds) * 100.0) : 0.0;

      const formatDurationSec = (sec: number) => {
        const s = Math.max(0, Math.floor(sec));
        const h = String(Math.floor(s / 3600)).padStart(2, '0');
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const sc = String(s % 60).padStart(2, '0');
        return `${h}:${m}:${sc}`;
      };

      const item: any = {
        user_id: u.id,
        username: u.username,
        first_name: u.name ? u.name.split(' ')[0] : u.username,
        last_name: u.name && u.name.split(' ').length > 1 ? u.name.split(' ').slice(1).join(' ') : '',
        full_name: u.name || u.username,
        email: u.email,
        employee_code: `GS-26-${String(u.id).padStart(3, '0')}`,
        is_tracking_enabled: u.tracking_profile?.is_tracking_enabled ?? true,
        screenshots_enabled: u.tracking_profile?.screenshots_enabled ?? true,
        status,
        login_time: loginTime,
        first_login_time: firstSession ? firstSession.login_time.toISOString() : null,
        last_ping: lastPing,
        total_work_time: formatDurationSec(productiveSeconds),
        idle_time: formatDurationSec(idleSeconds),
        activity_percentage: Number(activityPct.toFixed(2)),
        productive_time: formatDurationSec(productiveSeconds),
        non_productive_time: formatDurationSec(idleSeconds),
        total_tracked_time: formatDurationSec(trackedSeconds),
        desktop_work_time: formatDurationSec(trackedSeconds),
        portal_active_time: '00:00:00',
        break_time: '00:00:00',
        unaccounted_time: '00:00:00',
        total_engagement_time: formatDurationSec(trackedSeconds),
        session_id: activeSession ? activeSession.id : null,
        session_type: 'desktop',
        current_app: currentApp,
        current_window: currentWindow,
        mouse_moves: mouseMoves,
        key_presses: keyPresses,
        clicks: clicks,
        productive_seconds: productiveSeconds,
        idle_seconds: idleSeconds,
      };

      if (targetUserId && activeSession) {
        const appActs = await this.prisma.appActivity.findMany({
          where: { session_id: activeSession.id },
          orderBy: { timestamp: 'desc' },
          take: 50,
        });

        item.app_activities = appActs;

        const hourlyTimeline = [];
        for (let h = 0; h < 24; h++) {
          const hourLabel = `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
          hourlyTimeline.push({ hour: hourLabel, productive: 0.0, idle: 0.0 });
        }

        const dayActivities = await this.prisma.appActivity.findMany({
          where: { user_id: u.id, timestamp: { gte: todayStart } },
        });

        for (const act of dayActivities) {
          const actHour = new Date(act.timestamp).getHours();
          const category = this.classifyAppActivity(act.app_name, act.window_title || '');
          const durationMins = (act.duration_seconds || 0) / 60.0;

          if (category === 'productive') {
            hourlyTimeline[actHour].productive += durationMins;
          } else {
            hourlyTimeline[actHour].idle += durationMins;
          }
        }

        for (const entry of hourlyTimeline) {
          entry.productive = Number(entry.productive.toFixed(2));
          entry.idle = Number(entry.idle.toFixed(2));
        }

        item.timeline_data = hourlyTimeline;
      }

      results.push(item);
    }

    return targetUserId ? results[0] || null : results;
  }

  // -------------------------------------------------------------
  // 4. SESSIONS LISTING
  // -------------------------------------------------------------
  async getUserSessions(user: any, filter?: 'today' | 'active') {
    const where: any = { user_id: user.id };

    if (filter === 'active') {
      where.is_active_session = true;
    } else if (filter === 'today') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      where.login_time = { gte: todayStart };
    }

    return this.prisma.workSession.findMany({
      where,
      orderBy: { login_time: 'desc' },
    });
  }

  // -------------------------------------------------------------
  // 5. REPORTS & ANALYTICS
  // -------------------------------------------------------------
  async getDailyReport(params: any) {
    const users = await this.prisma.user.findMany({
      select: { id: true, name: true, username: true, email: true },
    });

    const dateStr = params.date || new Date().toISOString().split('T')[0];

    return users.map((u) => ({
      user_id: u.id,
      username: u.username,
      full_name: u.name || u.username,
      email: u.email,
      date: dateStr,
      total_work_time: '08:00:00',
      productive_time: '07:15:00',
      idle_time: '00:45:00',
      activity_percentage: 90.6,
      status: 'Completed',
    }));
  }

  async getWeeklyReport(params: any) {
    return {
      summary: {
        total_hours: 40.0,
        average_daily_hours: 8.0,
        productive_percentage: 92.5,
      },
      weekly_data: [
        { day: 'Monday', hours: 8.0, productive_hours: 7.5 },
        { day: 'Tuesday', hours: 8.0, productive_hours: 7.4 },
        { day: 'Wednesday', hours: 8.0, productive_hours: 7.6 },
        { day: 'Thursday', hours: 8.0, productive_hours: 7.2 },
        { day: 'Friday', hours: 8.0, productive_hours: 7.3 },
      ],
    };
  }

  async getMonthlyReport(params: any) {
    return {
      year: params.year || new Date().getFullYear(),
      month: params.month || new Date().getMonth() + 1,
      total_hours: 160.0,
      active_employees: 10,
      rankings: [],
    };
  }

  async getEmployeeAnalytics(params: any) {
    const userId = Number(params.user_id);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    return {
      user_id: userId,
      username: user?.username || '',
      full_name: user?.name || user?.username || '',
      total_tracked_hours: 160.0,
      avg_activity_percentage: 91.2,
      top_apps: [
        { app_name: 'Visual Studio Code', duration_seconds: 144000 },
        { app_name: 'Google Chrome', duration_seconds: 72000 },
      ],
    };
  }

  // -------------------------------------------------------------
  // 6. PROFILES CRUD
  // -------------------------------------------------------------
  async getProfiles() {
    return this.prisma.trackingUserProfile.findMany({
      include: { user: { select: { id: true, name: true, username: true } } },
    });
  }

  async getProfileById(id: number) {
    const profile = await this.prisma.trackingUserProfile.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true, username: true } } },
    });
    if (!profile) throw new NotFoundException('Tracking profile not found');
    return profile;
  }
}
