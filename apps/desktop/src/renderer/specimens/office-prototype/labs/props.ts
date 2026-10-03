/**
 * PROTOTYPE - the props lab: every piece of furniture in a row, as the props
 * kit builds it. Open labs/props.html.
 */
import type { Object3D } from "three";
import * as props from "../kit/props";
import { mountLab } from "./lab";

mountLab((stage) => {
  const desk = props.buildDesk();
  desk.setLamp(true);
  const pieces: Object3D[] = [
    desk.object,
    props.buildYourDesk().object,
    props.buildArmchair().object,
    props.buildStool().object,
    props.buildBench(3).object,
    props.buildLongTable(3).object,
    props.buildCabinet(),
    props.buildBookshelf(1.6),
    props.buildCaseBoard(2).object,
    props.buildPlant("small"),
    props.buildPlant("tall"),
    props.buildRug(2, 1.4),
    props.buildTeaTrolley(),
    props.buildCoatStand(),
    props.buildFloorLamp().object,
    props.buildWallClock(),
    props.buildNowServing().object,
    props.buildPigeonholes(),
    props.buildParcels(),
  ];
  pieces.forEach((piece, index) => {
    piece.position.x += (index % 5) * 2.4 - 4.8;
    piece.position.z += Math.floor(index / 5) * 2.4 - 3.6;
    stage.scene.add(piece);
  });
}, 14);
