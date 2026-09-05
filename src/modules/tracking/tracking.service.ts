import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
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

      let sessionProductiveSec = 0;
      let sessionIdleSec = 0;

      if (displaySession) {
        lastPing = displaySession.last_ping ? displaySession.last_ping.toISOString() : null;
        sessionProductiveSec = displaySession.productive_seconds || 0;
        sessionIdleSec = displaySession.idle_seconds || 0;
      }

      const todaySessions = await this.prisma.workSession.findMany({
        where: {
          user_id: u.id,
          OR: [
            { login_time: { gte: todayStart } },
            { is_active_session: true },
          ],
        },
      });

      let dailyProductiveSeconds = 0;
      let dailyIdleSeconds = 0;
      let dailyMouseMoves = 0;
      let dailyKeyPresses = 0;
      let dailyClicks = 0;

      for (const s of todaySessions) {
        dailyProductiveSeconds += s.productive_seconds || 0;
        dailyIdleSeconds += s.idle_seconds || 0;
        dailyMouseMoves += s.mouse_moves || 0;
        dailyKeyPresses += s.key_presses || 0;
        dailyClicks += s.clicks || 0;
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

      const dailyTrackedSeconds = dailyProductiveSeconds + dailyIdleSeconds;
      const activityPct = dailyTrackedSeconds > 0 ? Math.min(100.0, (dailyProductiveSeconds / dailyTrackedSeconds) * 100.0) : 0.0;

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
        total_work_time: formatDurationSec(dailyProductiveSeconds),
        idle_time: formatDurationSec(dailyIdleSeconds),
        activity_percentage: Number(activityPct.toFixed(2)),
        productive_time: formatDurationSec(dailyProductiveSeconds),
        non_productive_time: formatDurationSec(dailyIdleSeconds),
        total_tracked_time: formatDurationSec(dailyTrackedSeconds),
        desktop_work_time: formatDurationSec(dailyTrackedSeconds),
        portal_active_time: '00:00:00',
        break_time: '00:00:00',
        unaccounted_time: '00:00:00',
        total_engagement_time: formatDurationSec(dailyTrackedSeconds),
        session_id: activeSession ? activeSession.id : null,
        session_type: 'desktop',
        current_app: currentApp,
        current_window: currentWindow,
        mouse_moves: dailyMouseMoves,
        key_presses: dailyKeyPresses,
        clicks: dailyClicks,
        productive_seconds: sessionProductiveSec,
        idle_seconds: sessionIdleSec,
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
  detectBreaksAndGaps(sessionsList: any[], activitiesList: any[]) {
    const breaks: any[] = [];
    const sortedSessions = [...sessionsList].sort((a, b) => new Date(a.login_time).getTime() - new Date(b.login_time).getTime());

    for (let i = 0; i < sortedSessions.length - 1; i++) {
      const s1 = sortedSessions[i];
      const s2 = sortedSessions[i + 1];
      const d1 = new Date(s1.login_time).toDateString();
      const d2 = new Date(s2.login_time).toDateString();

      if (d1 === d2) {
        const logout = s1.logout_time || s1.last_ping;
        const login = s2.login_time;
        if (logout && new Date(login).getTime() > new Date(logout).getTime()) {
          const gap = Math.floor((new Date(login).getTime() - new Date(logout).getTime()) / 1000);
          if (gap >= 60) {
            breaks.push({
              start: new Date(logout),
              end: new Date(login),
              duration: gap,
              type: 'offline',
              description: 'Away from keyboard / Offline',
            });
          }
        }
      }
    }

    for (const session of sortedSessions) {
      const sessionActs = activitiesList
        .filter((act) => act.session_id === session.id)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      if (sessionActs.length >= 2) {
        for (let j = 0; j < sessionActs.length - 1; j++) {
          const act1 = sessionActs[j];
          const act2 = sessionActs[j + 1];
          const act1End = new Date(new Date(act1.timestamp).getTime() + (act1.duration_seconds || 10) * 1000);
          const act2Start = new Date(act2.timestamp);

          if (act2Start.getTime() > act1End.getTime()) {
            const gap = Math.floor((act2Start.getTime() - act1End.getTime()) / 1000);
            if (gap >= 180) {
              breaks.push({
                start: act1End,
                end: act2Start,
                duration: gap,
                type: 'idle',
                description: 'Idle session',
              });
            }
          }
        }
      }
    }

    breaks.sort((a, b) => a.start.getTime() - b.start.getTime());
    const totalBreakSec = breaks.reduce((acc, b) => acc + b.duration, 0);

    return {
      breaksList: breaks,
      breakCount: breaks.length,
      totalBreakSeconds: totalBreakSec,
    };
  }

  async getDailyReport(params: any) {
    const toLocalDateStr = (d: Date | string) => {
      const dt = new Date(d);
      const year = dt.getFullYear();
      const month = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    let startDateStr = params?.start_date;
    let endDateStr = params?.end_date;

    if (params?.date && !startDateStr && !endDateStr) {
      startDateStr = params.date;
      endDateStr = params.date;
    }

    const todayStr = toLocalDateStr(new Date());
    if (!startDateStr) startDateStr = todayStr;
    if (!endDateStr) endDateStr = startDateStr;

    const startDate = new Date(startDateStr.includes('T') ? startDateStr : `${startDateStr}T00:00:00`);
    const endDate = new Date(endDateStr.includes('T') ? endDateStr : `${endDateStr}T23:59:59.999`);

    const userWhere: any = {};
    if (params?.department_id) {
      userWhere.department_id = Number(params.department_id);
    }
    if (params?.user_id) {
      userWhere.id = Number(params.user_id);
    }
    if (params?.search) {
      const search = String(params.search).trim();
      userWhere.OR = [
        { name: { contains: search } },
        { username: { contains: search } },
        { email: { contains: search } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where: userWhere,
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        position: true,
        department: { select: { id: true, name: true } },
      },
    });

    const userIds = users.map((u) => u.id);

    const sessions = await this.prisma.workSession.findMany({
      where: {
        user_id: { in: userIds },
        login_time: { gte: startDate, lte: endDate },
      },
      orderBy: { login_time: 'asc' },
    });

    const activities = await this.prisma.appActivity.findMany({
      where: {
        user_id: { in: userIds },
        timestamp: { gte: startDate, lte: endDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    const reportRows: any[] = [];
    const now = new Date();

    const currDate = new Date(startDate);
    while (currDate <= endDate) {
      const dateIso = toLocalDateStr(currDate);

      for (const u of users) {
        const daySessions = sessions.filter((s) => s.user_id === u.id && toLocalDateStr(s.login_time) === dateIso);
        const dayActivities = activities.filter((a) => a.user_id === u.id && toLocalDateStr(a.timestamp) === dateIso);

        if (daySessions.length === 0) continue;

        const firstLogin = daySessions.reduce((min, s) => (s.login_time < min ? s.login_time : min), daySessions[0].login_time);
        const lastActive = daySessions.reduce((max, s) => {
          const t = s.logout_time || s.last_ping || s.login_time;
          return t > max ? t : max;
        }, daySessions[0].login_time);

        let productiveSec = 0;
        let idleSec = 0;
        let portalActiveSec = 0;

        for (const s of daySessions) {
          const sEnd = s.logout_time || s.last_ping || now;
          const sElapsed = Math.max(0, Math.floor((new Date(sEnd).getTime() - new Date(s.login_time).getTime()) / 1000));
          if (s.device_id === 'default') {
            portalActiveSec += sElapsed;
          } else {
            let sProd = Math.max(0, s.productive_seconds || 0);
            let sIdle = Math.max(0, s.idle_seconds || 0);
            if (sProd + sIdle > sElapsed) {
              if (sProd > sElapsed) {
                sProd = sElapsed;
                sIdle = 0;
              } else {
                sIdle = sElapsed - sProd;
              }
            }
            productiveSec += sProd;
            idleSec += sIdle;
          }
        }

        const breakAnalysis = this.detectBreaksAndGaps(daySessions, dayActivities);
        const offlineBreakSec = breakAnalysis.breaksList.filter((b) => b.type === 'offline').reduce((acc, b) => acc + b.duration, 0);
        const idleBreakSec = breakAnalysis.breaksList.filter((b) => b.type === 'idle').reduce((acc, b) => acc + b.duration, 0);

        const reconciledIdleSec = idleSec;
        const reconciledBreakSec = offlineBreakSec + idleBreakSec;

        const spannedDuration = Math.max(0, Math.floor((new Date(lastActive).getTime() - new Date(firstLogin).getTime()) / 1000));
        const desktopWorkSec = productiveSec + reconciledIdleSec;
        const totalEngagementSec = desktopWorkSec + portalActiveSec;

        const sumAccounted = productiveSec + reconciledIdleSec + portalActiveSec + reconciledBreakSec;
        const unaccountedSec = Math.max(0, spannedDuration - sumAccounted);

        const activityPct = desktopWorkSec > 0 ? Math.min(100.0, (productiveSec / desktopWorkSec) * 100.0) : 0.0;

        const fullName = u.name || u.username;
        const empCode = `GS-26-${String(u.id).padStart(3, '0')}`;
        const deptName = u.department?.name || 'General';

        const latestSession = daySessions[daySessions.length - 1];
        let status = 'Offline';
        if (dateIso === todayStr && latestSession.is_active_session) {
          const lastPingTime = latestSession.last_desktop_ping || latestSession.last_ping;
          if (lastPingTime) {
            const secSincePing = Math.floor((now.getTime() - new Date(lastPingTime).getTime()) / 1000);
            if (secSincePing <= 300) {
              status = latestSession.is_desktop_idle || secSincePing > 120 ? 'Idle' : 'Active';
            }
          }
        }

        reportRows.push({
          employee_name: fullName,
          employee_code: empCode,
          department: deptName,
          date: dateIso,
          productive_time: formatDurationSec(productiveSec),
          idle_time: formatDurationSec(reconciledIdleSec),
          desktop_work_time: formatDurationSec(desktopWorkSec),
          portal_active_time: formatDurationSec(portalActiveSec),
          break_time: formatDurationSec(reconciledBreakSec),
          unaccounted_time: formatDurationSec(unaccountedSec),
          total_engagement_time: formatDurationSec(totalEngagementSec),
          workday_span: formatDurationSec(spannedDuration),
          activity_percentage: Number(activityPct.toFixed(2)),
          status,

          user_id: u.id,
          username: u.username,
          full_name: fullName,
          email: u.email,
          first_login: firstLogin ? new Date(firstLogin).toISOString() : null,
          last_active: lastActive ? new Date(lastActive).toISOString() : null,
          total_tracked_time: formatDurationSec(desktopWorkSec),
          break_count: breakAnalysis.breakCount,

          raw_tracked_seconds: desktopWorkSec,
          raw_productive_seconds: productiveSec,
          raw_idle_seconds: reconciledIdleSec,
          raw_desktop_work_seconds: desktopWorkSec,
          raw_portal_active_seconds: portalActiveSec,
          raw_break_seconds: reconciledBreakSec,
          raw_unaccounted_seconds: unaccountedSec,
          raw_total_engagement_seconds: totalEngagementSec,
          raw_workday_span: spannedDuration,
        });
      }

      currDate.setDate(currDate.getDate() + 1);
    }

    return reportRows;
  }

  async getWeeklyReport(params: any) {
    const rows = await this.getDailyReport(params);

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    if (!rows || rows.length === 0) {
      return {
        total_weekly_hours: '00:00:00',
        average_activity_percentage: 0.0,
        most_productive_day: '-',
        total_idle_time: '00:00:00',
        attendance_days: 0,
        app_usage_summary: [],
        daily_productivity_trend: [],
        weekly_work_hours: [],
      };
    }

    const totalTrackedSec = rows.reduce((acc: number, r: any) => acc + (r.raw_tracked_seconds || 0), 0);
    const totalProductiveSec = rows.reduce((acc: number, r: any) => acc + (r.raw_productive_seconds || 0), 0);
    const totalIdleSec = rows.reduce((acc: number, r: any) => acc + (r.raw_idle_seconds || 0), 0);

    const avgActivity = totalTrackedSec > 0 ? (totalProductiveSec / totalTrackedSec) * 100.0 : 0.0;
    const attendanceDays = new Set(rows.map((r: any) => `${r.user_id}_${r.date}`)).size;

    const dayProductivity: Record<string, number> = {};
    for (const r of rows) {
      dayProductivity[r.date] = (dayProductivity[r.date] || 0) + r.raw_productive_seconds;
    }

    let mostProductiveDay = '-';
    const dates = Object.keys(dayProductivity);
    if (dates.length > 0) {
      const topDate = dates.reduce((a, b) => (dayProductivity[a] > dayProductivity[b] ? a : b));
      const dObj = new Date(topDate);
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      mostProductiveDay = `${dayNames[dObj.getDay()]} (${monthNames[dObj.getMonth()]} ${String(dObj.getDate()).padStart(2, '0')})`;
    }

    const userIds = Array.from(new Set(rows.map((r: any) => r.user_id)));
    const activities = await this.prisma.appActivity.findMany({
      where: { user_id: { in: userIds } },
      orderBy: { timestamp: 'desc' },
      take: 200,
    });

    const appGroup: Record<string, { duration: number; productive: number }> = {};
    for (const act of activities) {
      if (!appGroup[act.app_name]) appGroup[act.app_name] = { duration: 0, productive: 0 };
      appGroup[act.app_name].duration += act.duration_seconds || 0;
      appGroup[act.app_name].productive += act.productive_seconds || 0;
    }

    const appUsageSummary = Object.keys(appGroup)
      .map((name) => {
        const cat = this.classifyAppActivity(name, '');
        return {
          app_name: name,
          duration_seconds: appGroup[name].duration,
          duration_formatted: formatDurationSec(appGroup[name].duration),
          is_productive: cat === 'productive',
          category: cat.replace('_', ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
        };
      })
      .sort((a, b) => b.duration_seconds - a.duration_seconds)
      .slice(0, 10);

    const dailyProductivityTrend: any[] = [];
    const dateMap: Record<string, { prod: number; idle: number }> = {};
    for (const r of rows) {
      if (!dateMap[r.date]) dateMap[r.date] = { prod: 0, idle: 0 };
      dateMap[r.date].prod += r.raw_productive_seconds;
      dateMap[r.date].idle += r.raw_idle_seconds;
    }

    for (const dStr of Object.keys(dateMap).sort()) {
      const dObj = new Date(dStr);
      const dayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dObj.getDay()];
      const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dObj.getMonth()];
      dailyProductivityTrend.push({
        date: `${dayShort}, ${monthShort} ${String(dObj.getDate()).padStart(2, '0')}`,
        productive_hours: Number((dateMap[dStr].prod / 3600.0).toFixed(2)),
        idle_hours: Number((dateMap[dStr].idle / 3600.0).toFixed(2)),
      });
    }

    const userHoursMap: Record<string, number> = {};
    for (const r of rows) {
      userHoursMap[r.full_name] = (userHoursMap[r.full_name] || 0) + r.raw_tracked_seconds;
    }

    const weeklyWorkHours = Object.keys(userHoursMap).map((name) => ({
      employee: name,
      hours: Number((userHoursMap[name] / 3600.0).toFixed(2)),
    }));

    return {
      total_weekly_hours: formatDurationSec(totalTrackedSec),
      average_activity_percentage: Number(Math.min(100.0, avgActivity).toFixed(2)),
      most_productive_day: mostProductiveDay,
      total_idle_time: formatDurationSec(totalIdleSec),
      attendance_days: attendanceDays,
      app_usage_summary: appUsageSummary,
      daily_productivity_trend: dailyProductivityTrend,
      weekly_work_hours: weeklyWorkHours,
    };
  }

  async getMonthlyReport(params: any) {
    const now = new Date();
    const year = Number(params?.year || now.getFullYear());
    const month = Number(params?.month || now.getMonth() + 1);

    const startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDateStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const rows = await this.getDailyReport({ ...params, start_date: startDateStr, end_date: endDateStr });

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    if (!rows || rows.length === 0) {
      return {
        total_monthly_work_hours: '00:00:00',
        total_productive_hours: '00:00:00',
        total_idle_hours: '00:00:00',
        attendance_summary: {
          total_sessions: 0,
          avg_sessions_per_day: 0.0,
          unique_days_worked: 0,
          active_employees_count: 0,
        },
        employee_ranking: [],
        productivity_trends: [],
      };
    }

    const totalTrackedSec = rows.reduce((acc: number, r: any) => acc + (r.raw_tracked_seconds || 0), 0);
    const totalProductiveSec = rows.reduce((acc: number, r: any) => acc + (r.raw_productive_seconds || 0), 0);
    const totalIdleSec = rows.reduce((acc: number, r: any) => acc + (r.raw_idle_seconds || 0), 0);

    const uniqueDays = new Set(rows.map((r: any) => r.date)).size;
    const uniqueEmployees = new Set(rows.map((r: any) => r.user_id)).size;

    const empStats: Record<number, any> = {};
    for (const r of rows) {
      const uid = r.user_id;
      if (!empStats[uid]) {
        empStats[uid] = {
          user_id: uid,
          full_name: r.full_name,
          employee_code: r.employee_code,
          department: r.department,
          productive_sec: 0,
          idle_sec: 0,
          tracked_sec: 0,
        };
      }
      empStats[uid].productive_sec += r.raw_productive_seconds;
      empStats[uid].idle_sec += r.raw_idle_seconds;
      empStats[uid].tracked_sec += r.raw_tracked_seconds;
    }

    const employeeRanking = Object.values(empStats)
      .map((stats: any) => {
        const pct = stats.tracked_sec > 0 ? (stats.productive_sec / stats.tracked_sec) * 100.0 : 0.0;
        return {
          user_id: stats.user_id,
          full_name: stats.full_name,
          employee_code: stats.employee_code,
          department: stats.department,
          productive_hours: Number((stats.productive_sec / 3600.0).toFixed(2)),
          tracked_hours: Number((stats.tracked_sec / 3600.0).toFixed(2)),
          activity_percentage: Number(Math.min(100.0, pct).toFixed(2)),
        };
      })
      .sort((a: any, b: any) => b.productive_hours - a.productive_hours);

    const trendsGrouped: Record<string, { date: string; productive_hours: number; idle_hours: number }> = {};
    for (const r of rows) {
      if (!trendsGrouped[r.date]) {
        const dObj = new Date(r.date);
        const monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dObj.getMonth()];
        trendsGrouped[r.date] = {
          date: `${monthShort} ${String(dObj.getDate()).padStart(2, '0')}`,
          productive_hours: 0,
          idle_hours: 0,
        };
      }
      trendsGrouped[r.date].productive_hours += Number((r.raw_productive_seconds / 3600.0).toFixed(2));
      trendsGrouped[r.date].idle_hours += Number((r.raw_idle_seconds / 3600.0).toFixed(2));
    }

    return {
      total_monthly_work_hours: formatDurationSec(totalTrackedSec),
      total_productive_hours: formatDurationSec(totalProductiveSec),
      total_idle_hours: formatDurationSec(totalIdleSec),
      attendance_summary: {
        total_sessions: rows.length,
        avg_sessions_per_day: Number((rows.length / Math.max(1, uniqueDays)).toFixed(1)),
        unique_days_worked: uniqueDays,
        active_employees_count: uniqueEmployees,
      },
      employee_ranking: employeeRanking,
      productivity_trends: Object.values(trendsGrouped),
    };
  }

  async getEmployeeAnalytics(params: any) {
    const userId = Number(params?.user_id);
    if (!userId) throw new BadRequestException('user_id query parameter is required.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { department: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const todayStr = new Date().toISOString().split('T')[0];
    const endDateStr = params?.end_date || todayStr;
    const endDateObj = new Date(endDateStr);
    endDateObj.setHours(23, 59, 59, 999);

    const startDateObj = params?.start_date ? new Date(params.start_date) : new Date(endDateObj.getTime() - 6 * 86400000);
    startDateObj.setHours(0, 0, 0, 0);

    const startDateStr = startDateObj.toISOString().split('T')[0];

    const rows = await this.getDailyReport({ user_id: userId, start_date: startDateStr, end_date: endDateStr });
    const userRows = rows.filter((r: any) => r.user_id === userId);

    const activities = await this.prisma.appActivity.findMany({
      where: {
        user_id: userId,
        timestamp: { gte: startDateObj, lte: endDateObj },
      },
      orderBy: { timestamp: 'desc' },
    });

    const sessions = await this.prisma.workSession.findMany({
      where: {
        user_id: userId,
        login_time: { gte: startDateObj, lte: endDateObj },
      },
      orderBy: { login_time: 'asc' },
    });

    const formatDurationSec = (sec: number) => {
      const s = Math.max(0, Math.floor(sec));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sc = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sc}`;
    };

    const appStats: Record<string, any> = {};
    let totalAppSec = 0;
    for (const act of activities) {
      const cat = this.classifyAppActivity(act.app_name, act.window_title || '');
      if (!appStats[act.app_name]) {
        appStats[act.app_name] = {
          app_name: act.app_name,
          duration_seconds: 0,
          productive_seconds: 0,
          mouse_moves: 0,
          key_presses: 0,
          category: cat,
          is_productive: cat === 'productive',
        };
      }
      appStats[act.app_name].duration_seconds += act.duration_seconds || 0;
      appStats[act.app_name].productive_seconds += act.productive_seconds || 0;
      appStats[act.app_name].mouse_moves += act.mouse_moves || 0;
      appStats[act.app_name].key_presses += act.key_presses || 0;
      totalAppSec += act.duration_seconds || 0;
    }

    const formattedApps = Object.values(appStats)
      .map((st: any) => ({
        app_name: st.app_name,
        total_time: formatDurationSec(st.duration_seconds),
        productive_time: formatDurationSec(st.productive_seconds),
        mouse_moves: st.mouse_moves,
        key_presses: st.key_presses,
        category: st.category.replace('_', ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
        is_productive: st.is_productive,
        percentage_of_total: Number((totalAppSec > 0 ? (st.duration_seconds / totalAppSec) * 100 : 0).toFixed(2)),
      }))
      .sort((a, b) => b.percentage_of_total - a.percentage_of_total);

    const breakAnalysis = this.detectBreaksAndGaps(sessions, activities);
    const formattedBreaks = breakAnalysis.breaksList.map((b: any) => ({
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      duration: formatDurationSec(b.duration),
      type: b.type,
      description: b.description,
    }));

    const totalProd = userRows.reduce((acc: number, r: any) => acc + r.raw_productive_seconds, 0);
    const totalIdle = userRows.reduce((acc: number, r: any) => acc + r.raw_idle_seconds, 0);
    const totalTracked = userRows.reduce((acc: number, r: any) => acc + r.raw_tracked_seconds, 0);
    const totalPortal = userRows.reduce((acc: number, r: any) => acc + r.raw_portal_active_seconds, 0);
    const totalBreak = userRows.reduce((acc: number, r: any) => acc + r.raw_break_seconds, 0);
    const totalUnaccounted = userRows.reduce((acc: number, r: any) => acc + r.raw_unaccounted_seconds, 0);
    const totalEngagement = userRows.reduce((acc: number, r: any) => acc + r.raw_total_engagement_seconds, 0);
    const totalBreakCount = userRows.reduce((acc: number, r: any) => acc + r.break_count, 0);

    const avgActPct = totalTracked > 0 ? (totalProd / totalTracked) * 100.0 : 0.0;
    const fullName = user.name || user.username;
    const empCode = `GS-26-${String(user.id).padStart(3, '0')}`;

    return {
      employee: {
        id: user.id,
        username: user.username,
        full_name: fullName,
        email: user.email,
        employee_code: empCode,
        department: user.department?.name || 'General',
      },
      totals: {
        total_tracked_time: formatDurationSec(totalTracked),
        productive_time: formatDurationSec(totalProd),
        idle_time: formatDurationSec(totalIdle),
        desktop_work_time: formatDurationSec(totalTracked),
        portal_active_time: formatDurationSec(totalPortal),
        break_time: formatDurationSec(totalBreak),
        unaccounted_time: formatDurationSec(totalUnaccounted),
        total_engagement_time: formatDurationSec(totalEngagement),
        activity_percentage: Number(Math.min(100.0, avgActPct).toFixed(2)),
        break_count: totalBreakCount,
        total_break_time: formatDurationSec(totalBreak),
      },
      daily_breakdown: userRows,
      app_usage: formattedApps,
      breaks: formattedBreaks,
    };
  }

  async exportReport(res: any, query: any) {
    const exportFormat = String(query?.format || 'csv').toLowerCase();
    const reportType = String(query?.type || 'daily').toLowerCase();

    let data: any[] = [];
    let filename = `report_${new Date().toISOString().split('T')[0]}`;

    if (reportType === 'daily') {
      data = await this.getDailyReport(query);
      filename = `daily_report_${query?.start_date || new Date().toISOString().split('T')[0]}`;
    } else if (reportType === 'weekly') {
      const weekly = await this.getWeeklyReport(query);
      data = (weekly.daily_productivity_trend || []).map((trend: any) => ({
        Date: trend.date,
        'Productive Hours': trend.productive_hours,
        'Idle Hours': trend.idle_hours,
        'Total Tracked': Number((trend.productive_hours + trend.idle_hours).toFixed(2)),
      }));
      filename = `weekly_report_${query?.start_date || 'week'}`;
    } else if (reportType === 'monthly') {
      const monthly = await this.getMonthlyReport(query);
      data = monthly.employee_ranking || [];
      filename = `monthly_ranking_${query?.year || new Date().getFullYear()}_${query?.month || new Date().getMonth() + 1}`;
    } else if (reportType === 'employee') {
      const employee = await this.getEmployeeAnalytics(query);
      data = employee.daily_breakdown || [];
      filename = `employee_report_${employee.employee?.username || 'analytics'}`;
    }

    if (exportFormat === 'csv') {
      const headers = [
        'Employee Name', 'Employee Code', 'Department', 'Date',
        'Productive Time', 'Idle Time', 'Desktop Work Time', 'Portal Active Time',
        'Break Time', 'Unaccounted Time', 'Total Engagement Time', 'Workday Span',
        'Activity Percentage', 'Status'
      ];
      const keys = [
        'employee_name', 'employee_code', 'department', 'date',
        'productive_time', 'idle_time', 'desktop_work_time', 'portal_active_time',
        'break_time', 'unaccounted_time', 'total_engagement_time', 'workday_span',
        'activity_percentage', 'status'
      ];

      let csvStr = '';
      if (data.length > 0 && (reportType === 'daily' || reportType === 'employee')) {
        csvStr += headers.join(',') + '\n';
        for (const row of data) {
          const line = keys.map((k) => `"${row[k] !== undefined ? row[k] : '-'}"`).join(',');
          csvStr += line + '\n';
        }
      } else if (data.length > 0) {
        const rowKeys = Object.keys(data[0]);
        csvStr += rowKeys.join(',') + '\n';
        for (const row of data) {
          const line = rowKeys.map((k) => `"${row[k] !== undefined ? row[k] : '-'}"`).join(',');
          csvStr += line + '\n';
        }
      } else {
        csvStr = headers.join(',') + '\n';
      }

      res.set({
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      });
      return res.send(csvStr);
    } else if (exportFormat === 'excel') {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const sheetName = reportType.charAt(0).toUpperCase() + reportType.slice(1);
      const ws = wb.addWorksheet(sheetName);

      let headers: string[] = [];
      let keys: string[] = [];

      if (reportType === 'daily' || reportType === 'reconciliation' || reportType === 'employee') {
        headers = [
          'Employee Name', 'Employee Code', 'Department', 'Date',
          'Productive Time', 'Idle Time', 'Desktop Work Time', 'Portal Active Time',
          'Break Time', 'Unaccounted Time', 'Total Engagement Time', 'Workday Span',
          'Activity Percentage', 'Status'
        ];
        keys = [
          'employee_name', 'employee_code', 'department', 'date',
          'productive_time', 'idle_time', 'desktop_work_time', 'portal_active_time',
          'break_time', 'unaccounted_time', 'total_engagement_time', 'workday_span',
          'activity_percentage', 'status'
        ];
      } else if (data.length > 0) {
        keys = Object.keys(data[0]).filter((k) => !k.startsWith('raw_'));
        headers = keys.map((k) => k.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()));
      }

      if (headers.length > 0) {
        const headerRow = ws.addRow(headers);
        headerRow.height = 24;
        headerRow.eachCell((cell: any) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
          cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });

        for (const item of data) {
          const rowData = keys.map((k) => (item[k] !== undefined && item[k] !== null ? item[k] : '-'));
          const dataRow = ws.addRow(rowData);
          dataRow.height = 20;
        }

        ws.columns.forEach((column: any) => {
          let maxLen = 12;
          column.eachCell({ includeEmpty: true }, (cell: any) => {
            const valStr = cell.value !== undefined && cell.value !== null ? String(cell.value) : '';
            if (valStr.length > maxLen) {
              maxLen = valStr.length;
            }
          });
          column.width = Math.max(maxLen + 3, 12);
        });
      }

      const excelBuffer = await wb.xlsx.writeBuffer();
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
      });
      return res.send(Buffer.from(excelBuffer));
    } else if (exportFormat === 'pdf') {
      return new Promise<void>((resolve, reject) => {
        try {
          const PDFDocumentRaw = require('pdfkit');
          const PDFDocument = PDFDocumentRaw.default || PDFDocumentRaw;
          const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
          const chunks: Buffer[] = [];

          const fontsDir = path.join(process.cwd(), 'scripts', 'fonts');
          const regFontPath = path.join(fontsDir, 'Poppins-Regular.ttf');
          const medFontPath = path.join(fontsDir, 'Poppins-Medium.ttf');
          const boldFontPath = path.join(fontsDir, 'Poppins-Bold.ttf');

          if (fs.existsSync(regFontPath)) doc.registerFont('Poppins', regFontPath);
          if (fs.existsSync(medFontPath)) doc.registerFont('Poppins-Medium', medFontPath);
          if (fs.existsSync(boldFontPath)) doc.registerFont('Poppins-Bold', boldFontPath);

          doc.on('data', (chunk: Buffer) => chunks.push(chunk));
          doc.on('end', () => {
            const pdfBuffer = Buffer.concat(chunks);
            res.set({
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="${filename}.pdf"`,
            });
            res.send(pdfBuffer);
            resolve();
          });
          doc.on('error', (err: any) => reject(err));

          const startDateStr = String(query?.start_date || query?.date || new Date().toISOString().split('T')[0]);
          const endDateStr = String(query?.end_date || query?.date || startDateStr);

          this.generateReportPdf(doc, reportType, startDateStr, endDateStr, data);
          doc.end();
        } catch (err) {
          console.error('PDFKit error:', err);
          res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}.pdf"`,
          });
          res.send(Buffer.from(`%PDF-1.4 Report Output for ${filename}`));
          resolve();
        }
      });
    }

    throw new BadRequestException('Invalid format requested.');
  }

  private generateReportPdf(doc: any, reportType: string, startDateStr: string, endDateStr: string, data: any[]): void {
    const marginX = 30;
    const marginY = 30;
    const printableWidth = 841.89 - marginX * 2; // 781.89
    const maxY = 595.28 - marginY; // 565.28

    const titleReportName = reportType.charAt(0).toUpperCase() + reportType.slice(1);
    doc.fillColor('#1E293B')
       .font('Poppins-Bold')
       .fontSize(15)
       .text(`Grehasoft Work Tracking - ${titleReportName} Report (${startDateStr} to ${endDateStr})`, marginX, marginY);

    let currentY = marginY + 28;

    if (!data || data.length === 0) {
      doc.fillColor('#334155')
         .font('Poppins')
         .fontSize(10)
         .text('No tracking data recorded for this period.', marginX, currentY);
      return;
    }

    interface ColumnDef {
      key: string;
      label: string;
      width: number;
      align: 'left' | 'center' | 'right';
    }

    let columns: ColumnDef[] = [];
    const isLargeReport = reportType === 'daily' || reportType === 'reconciliation' || reportType === 'employee';

    if (isLargeReport) {
      columns = [
        { key: 'employee_name', label: 'Employee\nName', width: 95, align: 'left' },
        { key: 'employee_code', label: 'Employee\nCode', width: 50, align: 'left' },
        { key: 'department', label: 'Department', width: 80, align: 'left' },
        { key: 'date', label: 'Date', width: 55, align: 'center' },
        { key: 'productive_time', label: 'Productive\nTime', width: 50, align: 'center' },
        { key: 'idle_time', label: 'Idle\nTime', width: 47, align: 'center' },
        { key: 'desktop_work_time', label: 'Desktop\nWork', width: 47, align: 'center' },
        { key: 'portal_active_time', label: 'Portal\nActive', width: 47, align: 'center' },
        { key: 'break_time', label: 'Break\nTime', width: 47, align: 'center' },
        { key: 'unaccounted_time', label: 'Unaccounted\nTime', width: 56, align: 'center' },
        { key: 'total_engagement_time', label: 'Total\nEngagement', width: 55, align: 'center' },
        { key: 'workday_span', label: 'Workday\nSpan', width: 50, align: 'center' },
        { key: 'activity_percentage', label: 'Activity\n%', width: 44, align: 'center' },
        { key: 'status', label: 'Status', width: 58, align: 'center' },
      ];
    } else if (reportType === 'weekly') {
      columns = [
        { key: 'Date', label: 'Date', width: 180, align: 'left' },
        { key: 'Productive Hours', label: 'Productive Hours', width: 200, align: 'center' },
        { key: 'Idle Hours', label: 'Idle Hours', width: 200, align: 'center' },
        { key: 'Total Tracked', label: 'Total Tracked', width: 201, align: 'center' },
      ];
    } else if (reportType === 'monthly') {
      columns = [
        { key: 'full_name', label: 'Full Name', width: 160, align: 'left' },
        { key: 'employee_code', label: 'Employee Code', width: 100, align: 'left' },
        { key: 'department', label: 'Department', width: 140, align: 'left' },
        { key: 'productive_hours', label: 'Productive Hours', width: 120, align: 'center' },
        { key: 'tracked_hours', label: 'Tracked Hours', width: 120, align: 'center' },
        { key: 'activity_percentage', label: 'Activity %', width: 141, align: 'center' },
      ];
    }

    const headerFontSize = isLargeReport ? 7 : 10;
    const cellFontSize = isLargeReport ? 6.5 : 8.5;
    const headerHeight = isLargeReport ? 24 : 22;
    const rowHeight = isLargeReport ? 18 : 20;

    const drawHeader = (y: number) => {
      doc.rect(marginX, y, printableWidth, headerHeight)
         .fill('#4F46E5');

      let curX = marginX;
      for (const col of columns) {
        doc.rect(curX, y, col.width, headerHeight)
           .lineWidth(0.5)
           .stroke('#E2E8F0');

        doc.fillColor('#FFFFFF')
           .font('Poppins-Bold')
           .fontSize(headerFontSize);

        const lines = col.label.split('\n');
        if (lines.length === 1) {
          doc.text(col.label, curX + 2, y + (headerHeight - headerFontSize) / 2 - 1, {
            width: col.width - 4,
            align: 'center',
            lineBreak: false,
          });
        } else {
          const totalTextHeight = lines.length * (headerFontSize + 1);
          let startTextY = y + (headerHeight - totalTextHeight) / 2;
          for (const line of lines) {
            doc.text(line, curX + 2, startTextY, {
              width: col.width - 4,
              align: 'center',
              lineBreak: false,
            });
            startTextY += headerFontSize + 1;
          }
        }
        curX += col.width;
      }
    };

    drawHeader(currentY);
    currentY += headerHeight;

    for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
      if (currentY + rowHeight > maxY) {
        doc.addPage();
        currentY = marginY;
        drawHeader(currentY);
        currentY += headerHeight;
      }

      const row = data[rowIndex];
      const bgColor = rowIndex % 2 === 0 ? '#FFFFFF' : '#F1F5F9';

      doc.rect(marginX, currentY, printableWidth, rowHeight)
         .fill(bgColor);

      let curX = marginX;
      for (const col of columns) {
        doc.rect(curX, currentY, col.width, rowHeight)
           .lineWidth(0.5)
           .stroke('#E2E8F0');

        let val = row[col.key];
        if (val === undefined || val === null || val === '') {
          val = '-';
        } else {
          val = String(val);
        }

        if (col.key === 'status') {
          if (val === 'Active') doc.fillColor('#16A34A');
          else if (val === 'Idle') doc.fillColor('#D97706');
          else doc.fillColor('#64748B');
        } else {
          doc.fillColor('#1E293B');
        }

        doc.font('Poppins')
           .fontSize(cellFontSize);

        const textY = currentY + (rowHeight - cellFontSize) / 2 - 1;
        const paddingLeftRight = 3;

        doc.text(val, curX + paddingLeftRight, textY, {
          width: col.width - paddingLeftRight * 2,
          align: col.align,
          lineBreak: false,
        });

        curX += col.width;
      }

      currentY += rowHeight;
    }
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
