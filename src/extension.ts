import { Core, NodeCollection, EdgeCollection, NodeSingular, BoundingBoxWH, BoundingBox12 } from 'cytoscape';
import {
  IOutlineOptions,
  PointPath,
  Area,
  createLineInfluenceArea,
  createGenericInfluenceArea,
  createRectangleInfluenceArea,
  Rectangle,
  Circle,
  calculatePotentialOutline,
  IRectangle,
  IPoint,
  IPotentialOptions,
  defaultOptions,
  calculateVirtualEdges,
  IRoutingOptions,
  runIdle,
} from 'bubblesets-js';
import throttle from 'lodash.throttle';

export interface IPathOptions extends IOutlineOptions, IPotentialOptions, ICanvasStyle, IRoutingOptions {
  throttle?: number;
  drawPotentialArea?: boolean;
  virtualEdges?: boolean;
}

export interface ICanvasStyle {
  fillStyle?: string | CanvasGradient | CanvasPattern;
  strokeStyle?: string | CanvasGradient | CanvasPattern;
}

export interface IBubbleSetsPluginOptions extends IPathOptions {
  zIndex?: number;
  pixelRatio?: 'auto' | number;
}

export interface IBubbleSetNodeData {
  area?: Area;
  isCircle: boolean;
  shape: Circle | Rectangle;
}
export interface IBubbleSetEdgeData {
  areas: Area[];
  points: IPoint[];
}

const SCRATCH_KEY = 'bubbleSets';
const circularBase = ['ellipse', 'diamond', 'diamond', 'pentagon', 'diamond', 'hexagon', 'heptagon', 'octagon', 'star'];
const circular = new Set(circularBase.concat(circularBase.map((v) => `round-${v}`)));

function useCircle(shape: string) {
  return circular.has(shape);
}

function arrayEquals(a: IPoint[], b: IPoint[]) {
  return a.length === b.length && a.every((ai, i) => ai.x === b[i].x && ai.y === b[i].y);
}

function createShape(isCircle: boolean, bb: BoundingBox12 & BoundingBoxWH) {
  return isCircle
    ? new Circle(bb.x1 + bb.w / 2, bb.y1 + bb.h / 2, Math.max(bb.w, bb.h) / 2)
    : new Rectangle(bb.x1, bb.y1, bb.w, bb.h);
}

class BubbleSetPath {
  private path = new PointPath([]);
  private potentialAreaBB: IRectangle = { x: 0, y: 0, width: 0, height: 0 };
  private potentialArea: Area = new Area(4, 0, 0, 0, 0, 0, 0);
  private readonly options: Required<IPathOptions>;
  private readonly virtualEdgeAreas = new Map<string, Area>();

  private readonly throttledUpdate: () => void;

  constructor(
    private readonly plugin: BubbleSetsPlugin,
    public readonly nodes: NodeCollection,
    public readonly edges: EdgeCollection,
    public readonly avoidNodes: NodeCollection | null,
    options: IPathOptions = {}
  ) {
    this.options = Object.assign(
      {
        fillStyle: 'rgba(0,0,0,0.25)',
        strokeStyle: 'black',
        throttle: 100,
        drawPotentialArea: false,
        virtualEdges: true,
      },
      defaultOptions,
      options
    );

    this.throttledUpdate = throttle(() => {
      this.update();
      this.plugin.draw();
    }, this.options.throttle);

    nodes.on('add position remove', this.throttledUpdate);
    if (avoidNodes) {
      avoidNodes.on('add position remove', this.throttledUpdate);
    }
    edges.on('add move position position', this.throttledUpdate);
  }

  update = () => {
    const bb = this.nodes.union(this.edges).boundingBox({});
    let potentialAreaDirty = false;
    const padding = Math.max(this.options.edgeR1, this.options.nodeR1) + this.options.morphBuffer;
    const nextPotentialBB: IRectangle = {
      x: bb.x1 - padding,
      y: bb.y1 - padding,
      width: bb.w + padding * 2,
      height: bb.h + padding * 2,
    };
    if (this.potentialAreaBB.x !== nextPotentialBB.x || this.potentialAreaBB.y !== nextPotentialBB.y) {
      potentialAreaDirty = true;
      this.potentialArea = Area.fromPixelRegion(nextPotentialBB, this.options.pixelGroup);
    } else if (
      this.potentialAreaBB.width !== nextPotentialBB.width ||
      this.potentialAreaBB.height !== nextPotentialBB.height
    ) {
      // but not dirty
      this.potentialArea = Area.fromPixelRegion(nextPotentialBB, this.options.pixelGroup);
    }
    this.potentialAreaBB = nextPotentialBB;
    const potentialArea = this.potentialArea;

    const cache = new Map<string, Area>();
    let updateEdges = false;

    if (!potentialAreaDirty) {
      this.nodes.forEach((n) => {
        const data = (n.scratch(SCRATCH_KEY) ?? null) as IBubbleSetNodeData | null;
        if (data && data.area) {
          cache.set(`${data.shape.width}x${data.shape.height}x${data.isCircle}`, data.area);
        }
      });
    }

    const updateData = (n: NodeSingular) => {
      const bb = n.boundingBox({});
      let data = (n.scratch(SCRATCH_KEY) ?? null) as IBubbleSetNodeData | null;
      const isCircle = useCircle(n.style('shape'));
      if (
        !data ||
        potentialAreaDirty ||
        !data.area ||
        data.isCircle !== isCircle ||
        data.shape.width !== bb.w ||
        data.shape.height !== bb.h
      ) {
        // full recreate
        updateEdges = true;
        data = {
          isCircle,
          shape: createShape(isCircle, bb),
        };
        const key = `${data.shape.width}x${data.shape.height}x${data.isCircle}`;
        if (cache.has(key)) {
          data.area = this.potentialArea.copy(cache.get(key)!, {
            x: bb.x1 - this.options.nodeR1,
            y: bb.y1 - this.options.nodeR1,
          });
        } else {
          data.area = data!.isCircle
            ? createGenericInfluenceArea(data!.shape, potentialArea, this.options.nodeR1)
            : createRectangleInfluenceArea(data!.shape, potentialArea, this.options.nodeR1);
        }
        n.scratch(SCRATCH_KEY, data);
      } else if (data.shape.x !== bb.x1 || data.shape.y !== bb.y1) {
        updateEdges = true;
        data.shape = createShape(isCircle, bb);
        data.area = this.potentialArea.copy(data.area!, {
          x: bb.x1 - this.options.nodeR1,
          y: bb.y1 - this.options.nodeR1,
        });
      }

      return data;
    };

    const members = this.nodes.map(updateData);

    const nonMembers = !this.avoidNodes ? [] : this.avoidNodes.map(updateData);

    const edges: Area[] = [];
    this.edges.forEach((e) => {
      const ps = e.segmentPoints() ?? [e.sourceEndpoint(), e.targetEndpoint()];
      if (ps.length === 0) {
        return;
      }
      let data = (e.scratch(SCRATCH_KEY) ?? null) as IBubbleSetEdgeData | null;
      if (!data || potentialAreaDirty || !arrayEquals(data.points, ps)) {
        data = {
          points: ps,
          areas: ps.slice(1).map((next, i) => {
            const prev = ps[i];
            return createLineInfluenceArea(
              {
                x1: prev.x,
                y1: prev.y,
                x2: next.x,
                y2: next.y,
              },
              potentialArea,
              this.options.edgeR1
            );
          }),
        };
        e.scratch(SCRATCH_KEY, data);
      }
      edges.push(...data.areas);
    });

    const memberShapes = members.map((d) => d.shape);
    if (this.options.virtualEdges) {
      if (updateEdges) {
        const nonMembersShapes = nonMembers.map((d) => d.shape);
        const lines = calculateVirtualEdges(
          memberShapes,
          nonMembersShapes,
          this.options.maxRoutingIterations,
          this.options.morphBuffer
        );
        const bak = new Map(this.virtualEdgeAreas);
        this.virtualEdgeAreas.clear();
        lines.forEach((line) => {
          const key = `${line.x1}x${line.y1}x${line.x2}x${line.y2}`;
          const area = bak.get(key) ?? createLineInfluenceArea(line, potentialArea, this.options.edgeR1);
          this.virtualEdgeAreas.set(key, area);
          edges.push(area);
        });
      } else {
        this.virtualEdgeAreas.forEach((area) => edges.push(area));
      }
    }

    const memberAreas = members.map((d) => d.area!);
    const nonMemberAreas = nonMembers.map((d) => d.area!));
    let path = calculatePotentialOutline(
      potentialArea,
      memberAreas,
      edges,
      nonMemberAreas,
      (p) => p.containsElements(memberShapes),
      this.options
    );

    this.path = path.sample(8).simplify(0).bSplines().simplify(0);
  };

  draw(ctx: CanvasRenderingContext2D) {
    ctx.save();
    if (this.options.drawPotentialArea) {
      this.potentialArea.draw(ctx, true);
    }
    this.path.draw(ctx);
    if (this.options.strokeStyle) {
      ctx.strokeStyle = this.options.strokeStyle;
      ctx.stroke();
    }
    if (this.options.fillStyle) {
      ctx.fillStyle = this.options.fillStyle;
      ctx.fill();
    }
    ctx.restore();
  }

  remove() {
    this.nodes.off('add position remove', undefined, this.throttledUpdate);
    if (this.avoidNodes) {
      this.avoidNodes.off('add position remove', undefined, this.throttledUpdate);
      this.avoidNodes.forEach((d) => {
        d.scratch(SCRATCH_KEY, {});
      });
    }
    this.edges.off('add move position position', undefined, this.throttledUpdate);
    this.nodes.forEach((d) => {
      d.scratch(SCRATCH_KEY, {});
    });
    this.edges.forEach((d) => {
      d.scratch(SCRATCH_KEY, {});
    });
    this.plugin.removePath(this);
  }
}

// canvas ideas based on https://github.com/classcraft/cytoscape.js-canvas

class BubbleSetsPlugin {
  // private readonly bb: BubbleSets;
  readonly canvas: HTMLCanvasElement;
  private readonly pixelRatio: number;
  private readonly paths: BubbleSetPath[] = [];

  constructor(private readonly cy: Core, private readonly options: IBubbleSetsPluginOptions = {}) {
    const container = cy.container();

    const canvas = (this.canvas = (container?.ownerDocument ?? document).createElement('canvas'));
    if (container) {
      container.appendChild(canvas);
    }
    canvas.style.zIndex = (options.zIndex ?? 1).toString();
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.userSelect = 'none';
    canvas.style.outlineStyle = 'none';

    const oPixelRatio = options.pixelRatio ?? 'auto';
    this.pixelRatio = oPixelRatio === 'auto' ? window.devicePixelRatio : oPixelRatio;

    cy.on('render', () => {
      this.draw();
    });
    cy.on(
      'layoutstop move',
      throttle(() => {
        this.update();
      }, 200)
    );
    cy.on('resize', () => {
      canvas.width = cy.width() * this.pixelRatio;
      canvas.height = cy.height() * this.pixelRatio;

      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
      this.draw();
    });
  }

  addPath(nodes: NodeCollection, edges: EdgeCollection, avoidNodes: NodeCollection | null, options: IPathOptions = {}) {
    const path = new BubbleSetPath(this, nodes, edges, avoidNodes, Object.assign({}, this.options, options));
    this.paths.push(path);
    return path;
  }

  removePath(path: BubbleSetPath) {
    const i = this.paths.indexOf(path);
    if (i < 0) {
      return false;
    }
    this.paths.splice(i, 1);
    return true;
  }

  get ctx() {
    return this.canvas.getContext('2d')!;
  }

  clear() {
    const ctx = this.ctx;
    ctx.save();
    ctx.resetTransform();
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();
  }

  update() {
    this.paths.forEach((p) => p.update());
    this.draw();
  }

  draw() {
    this.clear();
    const pan = this.cy.pan();
    const zoom = this.cy.zoom();
    const ctx = this.ctx;
    ctx.save();
    ctx.resetTransform();
    ctx.translate(pan.x * this.pixelRatio, pan.y * this.pixelRatio);
    ctx.scale(zoom * this.pixelRatio, zoom * this.pixelRatio);

    this.paths.forEach((p) => p.draw(ctx));

    ctx.restore();
  }
}

export function bubbleSets(this: Core, options: IBubbleSetsPluginOptions = {}) {
  return new BubbleSetsPlugin(this, options);
}
