import configs from "../configs";
import EventEmitter from "eventemitter3";
import { Socket } from "phoenix";
import uuid from "uuid/v4";
import AuthContainer from "./AuthContainer";
import LoginDialog from "./LoginDialog";
import PublishDialog from "./PublishDialog";
import ProgressDialog from "../ui/dialogs/ProgressDialog";
import PerformanceCheckDialog from "../ui/dialogs/PerformanceCheckDialog";
import jwtDecode from "jwt-decode";
import { buildAbsoluteURL } from "url-toolkit";
import PublishedSceneDialog from "./PublishedSceneDialog";
import { matchesFileTypes, AudioFileTypes } from "../ui/assets/fileTypes";
import { RethrownError } from "../editor/utils/errors";

import { blobToBase64, getAccessToken } from "../belivvr/utils";

// Media related functions should be kept up to date with Hubs media-utils:
// https://github.com/mozilla/hubs/blob/master/src/utils/media-utils.js

const resolveUrlCache = new Map();
const resolveMediaCache = new Map();

const RETICULUM_SERVER = configs.RETICULUM_SERVER || document.location.hostname;
const MEDIA_SERVER = configs.MEDIA_SERVER;
const HEADERS = ({ json } = { json: true }) => {
  const headers = {
    authorization: `Bearer ${getAccessToken()}`
  };

  if (json) headers["content-type"] = "application/json";

  return headers;
};

// thanks to https://developer.mozilla.org/en-US/docs/Web/API/WindowBase64/Base64_encoding_and_decoding
function b64EncodeUnicode(str) {
  // first we use encodeURIComponent to get percent-encoded UTF-8, then we convert the percent-encodings
  // into raw bytes which can be fed into btoa.
  const CHAR_RE = /%([0-9A-F]{2})/g;
  return btoa(encodeURIComponent(str).replace(CHAR_RE, (_, p1) => String.fromCharCode("0x" + p1)));
}

const farsparkEncodeUrl = url => {
  // farspark doesn't know how to read '=' base64 padding characters
  // translate base64 + to - and / to _ for URL safety
  return b64EncodeUnicode(url)
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

const nonCorsProxyDomains = (configs.NON_CORS_PROXY_DOMAINS || "").split(",");
if (configs.CORS_PROXY_SERVER) {
  nonCorsProxyDomains.push(configs.CORS_PROXY_SERVER);
}

function shouldCorsProxy(url) {
  // Skip known domains that do not require CORS proxying.
  try {
    const parsedUrl = new URL(url);
    if (nonCorsProxyDomains.find(domain => parsedUrl.hostname.endsWith(domain))) return false;
  } catch (e) {
    // Ignore
  }

  return true;
}

export const proxiedUrlFor = url => {
  if (!(url.startsWith("http:") || url.startsWith("https:"))) return url;

  if (!shouldCorsProxy(url)) {
    return url;
  }

  return `${configs.CORS_PROXY_SERVER}/${url}`;
};

export const scaledThumbnailUrlFor = (url, width, height) => {
  if (configs.RETICULUM_SERVER.includes("hubs.local") && url.includes("hubs.local")) {
    return url;
  }

  return `${configs.THUMBNAIL_SERVER}/thumbnail/${farsparkEncodeUrl(url)}?w=${width}&h=${height}`;
};

const CommonKnownContentTypes = {
  gltf: "model/gltf",
  glb: "model/gltf-binary",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mp3: "audio/mpeg"
};

function guessContentType(url) {
  const extension = new URL(url).pathname.split(".").pop();
  return CommonKnownContentTypes[extension];
}

const LOCAL_STORE_KEY = "___hubs_store";

export default class Project extends EventEmitter {
  constructor() {
    super();

    const { protocol, host } = new URL(window.location.href);

    this.serverURL = protocol + "//" + host;
    this.apiURL = `${RETICULUM_SERVER}`;

    this.projectDirectoryPath = "/api/files/";

    // Max size in MB
    this.maxUploadSize = 128;
  }

  getAuthContainer() {
    return AuthContainer;
  }

  async authenticate(email, signal) {
    const reticulumServer = RETICULUM_SERVER;
    const socketUrl = `wss://${reticulumServer}/socket`;
    const socket = new Socket(socketUrl, { params: { session_id: uuid() } });
    socket.connect();

    const channel = socket.channel(`auth:${uuid()}`);

    const onAbort = () => socket.disconnect();

    signal.addEventListener("abort", onAbort);

    await new Promise((resolve, reject) =>
      channel
        .join()
        .receive("ok", resolve)
        .receive("error", err => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        })
    );

    const authComplete = new Promise(resolve =>
      channel.on("auth_credentials", ({ credentials: token }) => {
        localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify({ credentials: { email, token } }));
        this.emit("authentication-changed", true);
        resolve();
      })
    );

    channel.push("auth_request", { email, origin: "spoke" });

    signal.removeEventListener("abort", onAbort);

    return authComplete;
  }

  isAuthenticated() {
    return true;
  }

  getToken() {
    return getAccessToken();
  }

  getAccountId() {
    const token = this.getToken();
    return jwtDecode(token).sub;
  }

  logout() {
    localStorage.removeItem(LOCAL_STORE_KEY);
    this.emit("authentication-changed", false);
  }

  showLoginDialog(showDialog, hideDialog) {
    return new Promise(resolve => {
      showDialog(LoginDialog, {
        onSuccess: () => {
          hideDialog();
          resolve();
        }
      });
    });
  }

  async getProjects() {
    const response = await this.fetch(`${RETICULUM_SERVER}/api/v1/projects`, { headers: HEADERS() });

    const json = await response.json();

    if (!Array.isArray(json.projects)) {
      throw new Error(`Error fetching projects: ${json.error || "Unknown error."}`);
    }

    return json.projects;
  }

  async getProject(projectId) {
    const response = await this.fetch(`${RETICULUM_SERVER}/api/v1/projects/${projectId}`, {
      headers: HEADERS()
    });

    const json = await response.json();

    return json;
  }

  async getProjectlessScenes() {
    const response = await this.fetch(`${RETICULUM_SERVER}/api/v1/scenes/projectless`, { headers: HEADERS });

    const json = await response.json();

    if (!Array.isArray(json.scenes)) {
      throw new Error(`Error fetching scenes: ${json.error || "Unknown error."}`);
    }

    return json.scenes;
  }

  async resolveUrl(url, index) {
    if (!shouldCorsProxy(url)) {
      return { origin: url };
    }

    const cacheKey = `${url}|${index}`;
    if (resolveUrlCache.has(cacheKey)) return resolveUrlCache.get(cacheKey);

    const isSketchfab = url.includes("https://sketchfab.com/");

    const request = this.fetch(`${isSketchfab ? MEDIA_SERVER : RETICULUM_SERVER}/api/v1/media`, {
      method: "POST",
      headers: isSketchfab ? { "Content-Type": "application/json" } : HEADERS(),
      body: JSON.stringify({ media: { url, index } })
    }).then(async response => {
      if (!response.ok) {
        const message = `Error resolving url "${url}":\n  `;
        try {
          const body = await response.text();
          throw new Error(message + body.replace(/\n/g, "\n  "));
        } catch (e) {
          throw new Error(message + response.statusText.replace(/\n/g, "\n  "));
        }
      }

      return response.json();
    });

    resolveUrlCache.set(cacheKey, request);

    return request;
  }

  fetchContentType(accessibleUrl) {
    return this.fetch(accessibleUrl, { method: "HEAD" }).then(r => r.headers.get("content-type"));
  }

  async getContentType(url) {
    const result = await this.resolveUrl(url);
    const canonicalUrl = result.origin;
    const accessibleUrl = proxiedUrlFor(canonicalUrl);

    return (
      (result.meta && result.meta.expected_content_type) ||
      guessContentType(canonicalUrl) ||
      (await this.fetchContentType(accessibleUrl))
    );
  }

  async resolveMedia(url, index) {
    const absoluteUrl = new URL(url, window.location).href;

    if (absoluteUrl.startsWith(this.serverURL)) {
      return { accessibleUrl: absoluteUrl };
    }

    const cacheKey = `${absoluteUrl}|${index}`;

    if (resolveMediaCache.has(cacheKey)) return resolveMediaCache.get(cacheKey);

    const request = (async () => {
      let contentType, canonicalUrl, accessibleUrl, meta;

      try {
        const result = await this.resolveUrl(absoluteUrl);
        canonicalUrl = result.origin;
        meta = result.meta;
        accessibleUrl = proxiedUrlFor(canonicalUrl, index);

        contentType =
          (result.meta && result.meta.expected_content_type) ||
          guessContentType(canonicalUrl) ||
          (await this.fetchContentType(accessibleUrl));
      } catch (error) {
        throw new RethrownError(`Error resolving media "${absoluteUrl}"`, error);
      }

      try {
        if (contentType === "model/gltf+zip") {
          // TODO: Sketchfab object urls should be revoked after they are loaded by the glTF loader.
          const { getFilesFromSketchfabZip } = await import(
            /* webpackChunkName: "SketchfabZipLoader", webpackPrefetch: true */ "./SketchfabZipLoader"
          );
          const files = await getFilesFromSketchfabZip(accessibleUrl);
          return { canonicalUrl, accessibleUrl: files["scene.gtlf"].url, contentType, files };
        }
      } catch (error) {
        throw new RethrownError(`Error loading Sketchfab model "${accessibleUrl}"`, error);
      }

      return { canonicalUrl, accessibleUrl, contentType, meta };
    })();

    resolveMediaCache.set(cacheKey, request);

    return request;
  }

  proxyUrl(url) {
    return proxiedUrlFor(url);
  }

  unproxyUrl(baseUrl, url) {
    if (configs.CORS_PROXY_SERVER) {
      const corsProxyPrefix = configs.CORS_PROXY_SERVER;

      if (baseUrl.startsWith(corsProxyPrefix)) {
        baseUrl = baseUrl.substring(corsProxyPrefix.length);
      }

      if (url.startsWith(corsProxyPrefix)) {
        url = url.substring(corsProxyPrefix.length);
      }
    }

    // HACK HLS.js resolves relative urls internally, but our CORS proxying screws it up. Resolve relative to the original unproxied url.
    // TODO extend HLS.js to allow overriding of its internal resolving instead
    if (!url.startsWith("http")) {
      url = buildAbsoluteURL(baseUrl, url.startsWith("/") ? url : `/${url}`);
    }

    return proxiedUrlFor(url);
  }

  async searchMedia(source, params, cursor, signal) {
    const url = new URL(`${MEDIA_SERVER}/api/v1/media/search`);

    const headers = {
      "content-type": "application/json"
    };

    const searchParams = url.searchParams;

    searchParams.set("source", source);

    if (source === "assets") {
      searchParams.set("user", this.getAccountId());
    }

    if (params.type) {
      searchParams.set("type", params.type);
    }

    if (params.query) {
      searchParams.set("q", params.query);
    }

    if (params.filter) {
      searchParams.set("filter", params.filter);
    }

    if (params.collection) {
      searchParams.set("collection", params.collection);
    }

    if (cursor) {
      searchParams.set("cursor", cursor);
    }

    const resp = await this.fetch(url, { headers, signal });

    if (signal.aborted) {
      const error = new Error("Media search aborted");
      error.aborted = true;
      throw error;
    }

    const json = await resp.json();

    if (signal.aborted) {
      const error = new Error("Media search aborted");
      error.aborted = true;
      throw error;
    }

    const thumbnailedEntries = json.entries.map(entry => {
      if (entry.images && entry.images.preview && entry.images.preview.url) {
        if (entry.images.preview.type === "mp4") {
          entry.images.preview.url = proxiedUrlFor(entry.images.preview.url);
        } else {
          entry.images.preview.url = scaledThumbnailUrlFor(entry.images.preview.url, 200, 200);
        }
      }
      return entry;
    });

    return {
      results: thumbnailedEntries,
      suggestions: json.suggestions,
      nextCursor: json.meta.next_cursor
    };
  }

  async createProject(scene, parentSceneId, thumbnailBlob, signal, showDialog, hideDialog) {
    this.emit("project-saving");

    // Ensure the user is authenticated before continuing.
    if (!this.isAuthenticated()) {
      await new Promise(resolve => {
        showDialog(LoginDialog, {
          onSuccess: resolve
        });
      });
    }

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    const {
      file_id: thumbnail_file_id,
      meta: { access_token: thumbnail_file_token }
    } = await this.upload(thumbnailBlob, undefined, signal);

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    const serializedScene = scene.serialize();
    const projectBlob = new Blob([JSON.stringify(serializedScene)], { type: "application/json" });
    const {
      file_id: project_file_id,
      meta: { access_token: project_file_token }
    } = await this.upload(projectBlob, undefined, signal);

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    const project = {
      name: scene.name,
      thumbnail_file_id,
      thumbnail_file_token,
      project_file_id,
      project_file_token,
      custom_data: window.XRCLOUD?.customData
    };

    if (parentSceneId) {
      project.parent_scene_id = parentSceneId;
    }

    const body = JSON.stringify({ project });

    const projectEndpoint = `${RETICULUM_SERVER}/api/v1/projects`;

    const resp = await this.fetch(projectEndpoint, { method: "POST", headers: HEADERS(), body, signal });

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    if (resp.status === 401) {
      return await new Promise((resolve, reject) => {
        showDialog(LoginDialog, {
          onSuccess: async () => {
            try {
              const result = await this.createProject(
                scene,
                parentSceneId,
                thumbnailBlob,
                signal,
                showDialog,
                hideDialog
              );
              resolve(result);
            } catch (e) {
              reject(e);
            }
          }
        });
      });
    }

    if (resp.status !== 200) {
      throw new Error(`Project creation failed. ${await resp.text()}`);
    }

    const json = await resp.json();

    this.emit("project-saved");

    return json;
  }

  async deleteProject(projectId) {
    const projectEndpoint = `${RETICULUM_SERVER}/api/v1/projects/${projectId}`;

    const resp = await this.fetch(projectEndpoint, { method: "DELETE", headers: HEADERS() });

    if (resp.status === 401) {
      throw new Error("Not authenticated");
    }

    if (resp.status !== 200) {
      throw new Error(`Project deletion failed. ${await resp.text()}`);
    }

    return true;
  }

  async saveProject(projectId, editor, signal, showDialog, hideDialog) {
    this.emit("project-saving");

    // Ensure the user is authenticated before continuing.
    if (!this.isAuthenticated()) {
      await new Promise(resolve => {
        showDialog(LoginDialog, {
          onSuccess: resolve
        });
      });
    }

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    const thumbnailBlob = await editor.takeScreenshot(512, 320);

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    const {
      file_id: thumbnail_file_id,
      meta: { access_token: thumbnail_file_token }
    } = await this.upload(thumbnailBlob, undefined, signal);

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    const serializedScene = editor.scene.serialize();
    const projectBlob = new Blob([JSON.stringify(serializedScene)], { type: "application/json" });
    const {
      file_id: project_file_id,
      meta: { access_token: project_file_token }
    } = await this.upload(projectBlob, undefined, signal);

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    const project = {
      name: editor.scene.name,
      thumbnail_file_id,
      thumbnail_file_token,
      project_file_id,
      project_file_token,
      custom_data: window.XRCLOUD?.customData
    };

    const sceneId = editor.scene.metadata && editor.scene.metadata.sceneId ? editor.scene.metadata.sceneId : null;

    if (sceneId) {
      project.scene_id = sceneId;
    }

    const body = JSON.stringify({
      project
    });

    const projectEndpoint = `${RETICULUM_SERVER}/api/v1/projects/${projectId}`;

    const resp = await this.fetch(projectEndpoint, { method: "PATCH", headers: HEADERS(), body, signal });

    const json = await resp.json();

    if (signal.aborted) {
      throw new Error("Save project aborted");
    }

    if (resp.status === 401) {
      return await new Promise((resolve, reject) => {
        showDialog(LoginDialog, {
          onSuccess: async () => {
            try {
              const result = await this.saveProject(projectId, editor, signal, showDialog, hideDialog);
              resolve(result);
            } catch (e) {
              reject(e);
            }
          }
        });
      });
    }

    if (resp.status !== 200) {
      throw new Error(`Saving project failed. ${await resp.text()}`);
    }

    this.emit("project-saved");

    return json;
  }

  async getScene(sceneId) {
    const response = await this.fetch(`${RETICULUM_SERVER}/api/v1/scenes/${sceneId}`, {
      headers: HEADERS()
    });

    const json = await response.json();

    return json.scenes[0];
  }

  getSceneUrl(sceneId) {
    if (configs.HUBS_SERVER === "localhost:8080" || configs.HUBS_SERVER === "hubs.local:8080") {
      return `https://${configs.HUBS_SERVER}/scene.html?scene_id=${sceneId}`;
    } else {
      return `https://${configs.HUBS_SERVER}/scenes/${sceneId}`;
    }
  }

  async publishProject(project, editor, showDialog, hideDialog) {
    let screenshotUrl;

    try {
      const scene = editor.scene;

      const abortController = new AbortController();
      const signal = abortController.signal;

      // Save the scene if it has been modified.
      if (editor.sceneModified) {
        showDialog(ProgressDialog, {
          title: "Saving Project",
          message: "Saving project...",
          cancelable: true,
          onCancel: () => {
            abortController.abort();
          }
        });

        project = await this.saveProject(project.project_id, editor, signal, showDialog, hideDialog);

        if (signal.aborted) {
          const error = new Error("Publish project aborted");
          error.aborted = true;
          throw error;
        }
      }

      // Ensure the user is authenticated before continuing.
      if (!this.isAuthenticated()) {
        await new Promise(resolve => {
          showDialog(LoginDialog, {
            onSuccess: resolve
          });
        });
      }

      showDialog(ProgressDialog, {
        title: "Generating Project Screenshot",
        message: "Generating project screenshot..."
      });

      // Wait for 5ms so that the ProgressDialog shows up.
      await new Promise(resolve => setTimeout(resolve, 5));

      // Take a screenshot of the scene from the current camera position to use as the thumbnail
      const screenshotBlob = await editor.takeScreenshot();
      screenshotUrl = URL.createObjectURL(screenshotBlob);

      if (signal.aborted) {
        const error = new Error("Publish project aborted");
        error.aborted = true;
        throw error;
      }

      const userInfo = this.getUserInfo();

      // Gather all the info needed to display the publish dialog
      let { name, creatorAttribution, allowRemixing, allowPromotion } = scene.metadata;

      name = (project.scene && project.scene.name) || name || editor.scene.name;

      if (project.scene) {
        allowPromotion = project.scene.allow_promotion;
        allowRemixing = project.scene.allow_remixing;
        creatorAttribution = project.scene.attributions.creator || "";
      } else if ((!creatorAttribution || creatorAttribution.length === 0) && userInfo && userInfo.creatorAttribution) {
        creatorAttribution = userInfo.creatorAttribution;
      }

      const contentAttributions = scene.getContentAttributions();

      // Display the publish dialog and wait for the user to submit / cancel
      const publishParams = await new Promise(resolve => {
        showDialog(PublishDialog, {
          screenshotUrl,
          contentAttributions,
          initialSceneParams: {
            name,
            creatorAttribution: creatorAttribution || "",
            allowRemixing: typeof allowRemixing !== "undefined" ? allowRemixing : false,
            allowPromotion: typeof allowPromotion !== "undefined" ? allowPromotion : false
          },
          onCancel: () => resolve(null),
          onPublish: resolve
        });
      });

      // User clicked cancel
      if (!publishParams) {
        URL.revokeObjectURL(screenshotUrl);
        hideDialog();
        const error = new Error("Publish project aborted");
        error.aborted = true;
        throw error;
      }

      // Update the scene with the metadata from the publishDialog
      scene.setMetadata({
        name: publishParams.name,
        creatorAttribution: publishParams.creatorAttribution,
        allowRemixing: publishParams.allowRemixing,
        allowPromotion: publishParams.allowPromotion
      });

      // Save the creatorAttribution to localStorage so that the user doesn't have to input it again
      this.setUserInfo({ creatorAttribution: publishParams.creatorAttribution });

      showDialog(ProgressDialog, {
        title: "Publishing Scene",
        message: "Exporting scene...",
        cancelable: true,
        onCancel: () => {
          abortController.abort();
        }
      });

      // Clone the existing scene, process it for exporting, and then export as a glb blob
      const { glbBlob, scores } = await editor.exportScene(abortController.signal, { scores: true });

      if (signal.aborted) {
        const error = new Error("Publish project aborted");
        error.aborted = true;
        throw error;
      }

      const performanceCheckResult = await new Promise(resolve => {
        showDialog(PerformanceCheckDialog, {
          scores,
          onCancel: () => resolve(false),
          onConfirm: () => resolve(true)
        });
      });

      if (!performanceCheckResult) {
        const error = new Error("Publish project canceled");
        error.aborted = true;
        throw error;
      }

      // Serialize Spoke scene
      const serializedScene = editor.scene.serialize();
      const sceneBlob = new Blob([JSON.stringify(serializedScene)], { type: "application/json" });

      showDialog(ProgressDialog, {
        title: "Publishing Scene",
        message: `Publishing scene`,
        cancelable: true,
        onCancel: () => {
          abortController.abort();
        }
      });

      const size = glbBlob.size / 1024 / 1024;
      const maxSize = this.maxUploadSize;
      if (size > maxSize) {
        throw new Error(`Scene is too large (${size.toFixed(2)}MB) to publish. Maximum size is ${maxSize}MB.`);
      }

      showDialog(ProgressDialog, {
        title: "Publishing Scene",
        message: "Uploading thumbnail...",
        cancelable: true,
        onCancel: () => {
          abortController.abort();
        }
      });

      // Upload the screenshot file
      const {
        file_id: screenshotId,
        meta: { access_token: screenshotToken }
      } = await this.upload(screenshotBlob, undefined, abortController.signal);

      if (signal.aborted) {
        const error = new Error("Publish project aborted");
        error.aborted = true;
        throw error;
      }

      const {
        file_id: glbId,
        meta: { access_token: glbToken }
      } = await this.upload(glbBlob, uploadProgress => {
        showDialog(
          ProgressDialog,
          {
            title: "Publishing Scene",
            message: `Uploading scene: ${Math.floor(uploadProgress * 100)}%`,
            onCancel: () => {
              abortController.abort();
            }
          },
          abortController.signal
        );
      });

      if (signal.aborted) {
        const error = new Error("Publish project aborted");
        error.aborted = true;
        throw error;
      }

      const {
        file_id: sceneFileId,
        meta: { access_token: sceneFileToken }
      } = await this.upload(sceneBlob, undefined, abortController.signal);

      if (signal.aborted) {
        const error = new Error("Publish project aborted");
        error.aborted = true;
        throw error;
      }

      const sceneParams = {
        screenshot_file_id: screenshotId,
        screenshot_file_token: screenshotToken,
        model_file_id: glbId,
        model_file_token: glbToken,
        scene_file_id: sceneFileId,
        scene_file_token: sceneFileToken,
        allow_remixing: publishParams.allowRemixing,
        allow_promotion: publishParams.allowPromotion,
        name: publishParams.name,
        attributions: {
          creator: publishParams.creatorAttribution && publishParams.creatorAttribution.trim(),
          content: publishParams.contentAttributions
        }
      };

      const body = JSON.stringify({ scene: sceneParams });

      const resp = await this.fetch(`${RETICULUM_SERVER}/api/v1/projects/${project.project_id}/publish`, {
        method: "POST",
        headers: HEADERS(),
        body
      });

      if (signal.aborted) {
        const error = new Error("Publish project aborted");
        error.aborted = true;
        throw error;
      }

      if (resp.status === 401) {
        return await new Promise((resolve, reject) => {
          showDialog(LoginDialog, {
            onSuccess: async () => {
              try {
                const result = await this.publish(editor, showDialog, hideDialog);
                resolve(result);
              } catch (e) {
                reject(e);
              }
            }
          });
        });
      }

      if (resp.status !== 200) {
        throw new Error(`Scene creation failed. ${await resp.text()}`);
      }

      project = await resp.json();

      showDialog(PublishedSceneDialog, {
        sceneName: sceneParams.name,
        screenshotUrl,
        sceneUrl: this.getSceneUrl(project.scene.scene_id),
        onConfirm: () => {
          this.emit("project-published");
          hideDialog();
        }
      });
    } finally {
      if (screenshotUrl) {
        URL.revokeObjectURL(screenshotUrl);
      }
    }

    return project;
  }

  async publishGLBScene(screenshotFile, glbFile, params, signal, sceneId) {
    let screenshotId, screenshotToken;
    if (screenshotFile) {
      const {
        file_id,
        meta: { access_token }
      } = await this.upload(screenshotFile, null, signal);
      screenshotId = file_id;
      screenshotToken = access_token;
    }

    let glbId, glbToken;
    if (glbFile) {
      const {
        file_id,
        meta: { access_token }
      } = await this.upload(glbFile, null, signal);
      glbId = file_id;
      glbToken = access_token;
    }

    const sceneParams = {
      screenshot_file_id: screenshotId,
      screenshot_file_token: screenshotToken,
      model_file_id: glbId,
      model_file_token: glbToken,
      ...params
    };

    const body = JSON.stringify({ scene: sceneParams });

    const resp = await this.fetch(`${RETICULUM_SERVER}/api/v1/scenes${sceneId ? "/" + sceneId : ""}`, {
      method: sceneId ? "PUT" : "POST",
      headers: HEADERS(),
      body
    });

    return resp.json();
  }

  async upload(blob) {
    const formData = new FormData();
    formData.set("media", await blobToBase64(blob));

    return fetch(`${RETICULUM_SERVER}/api/v1/media`, {
      method: "POST",
      headers: HEADERS({ json: false }),
      body: formData
    }).then(response => response.json());
  }

  uploadAssets(editor, files, onProgress, signal) {
    return this._uploadAssets(`${RETICULUM_SERVER}/api/v1/assets`, editor, files, onProgress, signal);
  }

  async _uploadAssets(endpoint, editor, files, onProgress, signal) {
    const assets = [];

    for (const file of Array.from(files)) {
      if (signal.aborted) {
        break;
      }

      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      signal.addEventListener("abort", onAbort);

      const asset = await this._uploadAsset(
        endpoint,
        editor,
        file,
        progress => onProgress(assets.length + 1, files.length, progress),
        abortController.signal
      );

      assets.push(asset);
      signal.removeEventListener("abort", onAbort);

      if (signal.aborted) {
        break;
      }
    }

    return assets;
  }

  uploadAsset(editor, file, onProgress, signal) {
    return this._uploadAsset(`${RETICULUM_SERVER}/api/v1/assets`, editor, file, onProgress, signal);
  }

  uploadProjectAsset(editor, projectId, file, onProgress, signal) {
    return this._uploadAsset(
      `${RETICULUM_SERVER}/api/v1/projects/${projectId}/assets`,
      editor,
      file,
      onProgress,
      signal
    );
  }

  lastUploadAssetRequest = 0;

  async _uploadAsset(endpoint, editor, file, onProgress, signal) {
    let thumbnail_file_id = null;
    let thumbnail_access_token = null;

    if (!matchesFileTypes(file, AudioFileTypes)) {
      const thumbnailBlob = await editor.generateFileThumbnail(file);

      const response = await this.upload(thumbnailBlob, undefined, signal);

      thumbnail_file_id = response.file_id;
      thumbnail_access_token = response.meta.access_token;
    }

    const {
      file_id: asset_file_id,
      meta: { access_token: asset_access_token }
    } = await this.upload(file, onProgress, signal);

    const delta = Date.now() - this.lastUploadAssetRequest;

    if (delta < 1100) {
      await new Promise(resolve => setTimeout(resolve, 1100 - delta));
    }

    const body = JSON.stringify({
      asset: {
        name: file.name,
        file_id: asset_file_id,
        access_token: asset_access_token,
        thumbnail_file_id,
        thumbnail_access_token
      }
    });

    const resp = await this.fetch(endpoint, { method: "POST", headers: HEADERS(), body, signal });

    const json = await resp.json();

    const asset = json.assets[0];

    this.lastUploadAssetRequest = Date.now();

    return {
      id: asset.asset_id,
      name: asset.name,
      url: asset.file_url,
      type: asset.type,
      attributions: {},
      images: {
        preview: { url: asset.thumbnail_url }
      }
    };
  }

  async deleteAsset(assetId) {
    const assetEndpoint = `${RETICULUM_SERVER}/api/v1/assets/${assetId}`;

    const resp = await this.fetch(assetEndpoint, { method: "DELETE", headers: HEADERS() });

    if (resp.status === 401) {
      throw new Error("Not authenticated");
    }

    if (resp.status !== 200) {
      throw new Error(`Asset deletion failed. ${await resp.text()}`);
    }

    return true;
  }

  async deleteProjectAsset(projectId, assetId) {
    const projectAssetEndpoint = `${RETICULUM_SERVER}/api/v1/projects/${projectId}/assets/${assetId}`;

    const resp = await this.fetch(projectAssetEndpoint, { method: "DELETE", headers: HEADERS() });

    if (resp.status === 401) {
      throw new Error("Not authenticated");
    }

    if (resp.status !== 200) {
      throw new Error(`Project Asset deletion failed. ${await resp.text()}`);
    }

    return true;
  }

  setUserInfo(userInfo) {
    localStorage.setItem("spoke-user-info", JSON.stringify(userInfo));
  }

  getUserInfo() {
    return JSON.parse(localStorage.getItem("spoke-user-info"));
  }

  async fetch(url, options) {
    try {
      const res = await fetch(url, options);

      if (res.ok) {
        return res;
      }

      const err = new Error(
        `Network Error: ${res.status || "Unknown Status."} ${res.statusText || "Unknown Error. Possibly a CORS error."}`
      );
      err.response = res;
      throw err;
    } catch (error) {
      if (error.message === "Failed to fetch") {
        error.message += " (Possibly a CORS error)";
      }
      throw new RethrownError(`Failed to fetch "${url}"`, error);
    }
  }
}
