import EditorNodeMixin from "./EditorNodeMixin";
import Image, { ImageAlphaMode } from "../objects/Image";
import spokeLogoSrc from "../../assets/spoke-icon.png";
import { RethrownError } from "../utils/errors";
import { getObjectPerfIssues, maybeAddLargeFileIssue } from "../utils/performance";
import getSrcFromJSON from "../../vendor/belivvr/getSrcFromJSON";

export default class ImageNode extends EditorNodeMixin(Image) {
  static componentName = "image";

  static nodeName = "Image";

  static initialElementProps = {
    src: new URL(spokeLogoSrc, location).href,
    changeableSrc: "https://hubs-1-assets.hubs.belivvr.com/assets/public/test1.json"
  };

  static async deserialize(editor, json, loadAsync, onError) {
    const node = await super.deserialize(editor, json);

    const { changeable, changeableSrc, src, projection, controls, alphaMode, alphaCutoff } = json.components.find(
      c => c.name === "image"
    ).props;

    if (json.components.find(c => c.name === "billboard")) {
      node.billboard = true;
    }

    loadAsync(
      (async () => {
        if (changeable) {
          await node.load(await getSrcFromJSON(changeableSrc), onError);
        } else {
          await node.load(src, onError);
        }

        node.changeable = changeable;
        node.changeableSrc = changeableSrc;
        node.controls = controls || false;
        node.alphaMode = alphaMode === undefined ? ImageAlphaMode.Blend : alphaMode;
        node.alphaCutoff = alphaCutoff === undefined ? 0.5 : alphaCutoff;
        node.projection = projection;
      })()
    );

    const linkComponent = json.components.find(c => c.name === "link");

    if (linkComponent) {
      node.href = linkComponent.props.href;
    }

    return node;
  }

  constructor(editor) {
    super(editor);

    this._changeable = false;
    this._changeableSrc = "";
    this._canonicalUrl = "";
    this.href = "";
    this.controls = true;
    this.billboard = false;
  }

  get src() {
    return this._canonicalUrl;
  }

  get changeableSrc() {
    return this._changeableSrc;
  }

  get changeable() {
    return this._changeable;
  }

  set src(value) {
    this.load(value).catch(console.error);
  }

  set changeableSrc(value) {
    this._changeableSrc = value;

    if (this.changeable) {
      getSrcFromJSON(value).then(src => this.load(src).catch(console.error));
    }
  }

  set changeable(value) {
    this._changeable = value;

    if (this.changeable) {
      getSrcFromJSON(this.changeableSrc).then(src => this.load(src).catch(console.error));
    }
  }

  onChange() {
    this.onResize();
  }

  loadTexture(src) {
    return this.editor.textureCache.get(src);
  }

  async load(src, onError) {
    const nextSrc = src || "";

    if (nextSrc === this._canonicalUrl && nextSrc !== "") {
      return;
    }

    this._canonicalUrl = nextSrc;

    this.issues = [];
    this._mesh.visible = false;

    this.hideErrorIcon();
    this.showLoadingCube();

    try {
      const { accessibleUrl, meta } = await this.editor.api.resolveMedia(src);

      this.meta = meta;

      this.updateAttribution();

      await super.load(accessibleUrl);
      this.issues = getObjectPerfIssues(this._mesh, false);

      const perfEntries = performance.getEntriesByName(accessibleUrl);

      if (perfEntries.length > 0) {
        const imageSize = perfEntries[0].encodedBodySize;
        maybeAddLargeFileIssue("image", imageSize, this.issues);
      }
    } catch (error) {
      this.showErrorIcon();

      const imageError = new RethrownError(`Error loading image ${this._canonicalUrl}`, error);

      if (onError) {
        onError(this, imageError);
      }

      console.error(imageError);

      this.issues.push({ severity: "error", message: "Error loading image." });
    }

    this.editor.emit("objectsChanged", [this]);
    this.editor.emit("selectionChanged");
    this.hideLoadingCube();

    return this;
  }

  copy(source, recursive = true) {
    super.copy(source, recursive);

    this.controls = source.controls;
    this.billboard = source.billboard;
    this.alphaMode = source.alphaMode;
    this.alphaCutoff = source.alphaCutoff;
    this._canonicalUrl = source._canonicalUrl;
    this._changeable = source._changeable;
    this._changeableSrc = source._changeableSrc;
    this.href = source.href;

    return this;
  }

  serialize() {
    const components = {
      image: {
        src: this._canonicalUrl,
        changeable: this.changeable,
        changeableSrc: this.changeableSrc,
        controls: this.controls,
        alphaMode: this.alphaMode,
        alphaCutoff: this.alphaCutoff,
        projection: this.projection
      }
    };

    if (this.billboard) {
      components.billboard = {};
    }

    if (this.href) {
      components.link = { href: this.href };
    }

    return super.serialize(components);
  }

  prepareForExport() {
    super.prepareForExport();

    const imageData = {
      src: this._canonicalUrl,
      changeable: this.changeable,
      changeableSrc: this.changeableSrc,
      controls: this.controls,
      alphaMode: this.alphaMode,
      projection: this.projection
    };

    if (this.alphaMode === ImageAlphaMode.Mask) {
      imageData.alphaCutoff = this.alphaCutoff;
    }

    this.addGLTFComponent("image", imageData);

    this.addGLTFComponent("networked", {
      id: this.uuid
    });

    if (this.billboard && this.projection === "flat") {
      this.addGLTFComponent("billboard", {});
    }

    if (this.href && this.projection === "flat") {
      this.addGLTFComponent("link", { href: this.href });
    }

    this.replaceObject();
  }

  getRuntimeResourcesForStats() {
    if (this._texture) {
      return { textures: [this._texture], meshes: [this._mesh], materials: [this._mesh.material] };
    }
  }
}
