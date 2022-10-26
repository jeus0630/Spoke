/**
 * @returns { string }
 */
export function getProjectId() {
  return window.XRCLOUD?.projectId || location.pathname.split("/").pop();
}

/**
 * @returns { string }
 * @throws { TypeError }
 */
export function getAccessToken() {
  return JSON.parse(localStorage.getItem("recoil-persist")).accessToken;
}

/**
 * @param { Blob } blob
 * @returns { Promise<string> }
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * @returns { string }
 * @throws { TypeError }
 */
export function getAccessKey() {
  return JSON.parse(localStorage.getItem("recoil-persist")).accessKey;
}
