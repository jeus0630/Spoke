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
  try {
    return window.XRCLOUD?.accessToken || JSON.parse(localStorage.getItem("recoil-persist")).accessToken;
  } catch {
    return "";
  }
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
 */
export function getAccessKey() {
  return location.href
    .split("/")
    .filter(item =>
      /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/.test(item)
    )[0];
}
