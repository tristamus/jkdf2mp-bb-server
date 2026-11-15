// The names of the games' own models (.3do), lowercased and without .3do:
// Jedi Knight's Resource/Res2.gob (477) and Mysteries of the Sith's
// Resource/JKMRES.GOO (855), 1059 in all. Massassi's 3D preview reads both
// for every level, over the level's own files (levels-parts.js). Names only.
export const OFFICIAL_3DO = new Set((
    "00crte 00crte6x6 00picrte 00tabl 00tetris 00wexp1a 00wexp1b 01c3x8 01chr 01colm 01crte 01frt 01func " +
    "01rfd0 01rfd1 01rfd2 01rfd3 01tabl 02crate1 02crate2 02crate3 03block 03blockb 03blockt 03d2x3 03d2x3_2 " +
    "03d3x3 03d3x3_2 03d3x3_3a 03d4x3_a 03d4x3_b 03d4x4_a 03d4x4_b 03trcr 04beam1 04beam2 04d2x3 04p2x3 " +
    "04vatrn 04water 05road 05road2 05road3 05vcrowm 05vtiebm 05vtrnwg 06bolt 06buck 06colm 06count2 06countr " +
    "06d3x2 06door3 06lock_1 06lock_2 06lock_a 06lock_b 06lock_x 06lock_y 06lock_z 06lockab 06mound 06rock1 " +
    "06rock2 06step 06struta 06strutb 06wexp1a 06wexp1b 06wl1 06wl2 06wl3 06wl4 06wl5 07arch 07beam 07d4x4 " +
    "07d5x4 07lift 08dbrg 09bogus 09c3x8 09c3x8_1 09d2x2_1 09d2x3_1 09d2x3_2 09doct1 09pipb 09pipe18 09pipe40 " +
    "09pj08 09pj16 09slice 09tnk 09walkwy 10beam09 10beam10 10d3x3 10door1a 10door1b 10door2 10door3 10door4 " +
    "12d2x3_1 12dr01 12dr02_a 12dr02_b 12dr03 12epad 12pad2 12uwalk 12uwalka 12uwalkb 12uwalkc 13rock 14bpip " +
    "14brdg 14d13x10 14d8x8 14towr_a 14towr_b 14towr_c 14towr_d 15c47x4 15c50x4 15r2x1 15r2x1d 16grnd 16spir " +
    "16vale 16world 18wedge 19e2x2 19hands 19stndoor 21hands 21rope03 21wght01 24ddoor 24pdoor 3x8d 41cord " +
    "41d16x8 41rod 41rod6 43clamp 43p2x3 52eye 52utdr 53beam0 53beam1 53beam2 53clm1 53clm2 53d2x3 53d4x3 " +
    "53e2x2 54btr1 54btr2 54bvine 54clm1 54clm2 54d8x8 54d8x81a 54d8x81b 54d8x82a 54d8x82b 54d8x83a 54d8x83b " +
    "54d8x84 54e2x4 54e4x4 54epad 54rope02 54stat 54wexp1a 54wexp1b 8b 8t 8tbighed 8thead 8tsit 8x8ev aa " +
    "aabody aalegs ab ad adpart0 adpart1 adpart2 adpart3 adpart4 ap assault1 assault1_flt astroid at atray " +
    "atrn01 awing1 awing1_flt awing_lo1 b-key bact battery bayd bayd_a bayd_b beam beam02 beam03 bed bfboss " +
    "bigdoor blimp1 blimp2 blsg blsp blsv blsv_m bo bones boom boost bottle1 bottle2 bottle3 bottle4 bottle5 " +
    "bottle6 bottles1 bottles2 bottles3 bottles4 bottles5 bottles6 bow0 bow1 bowg bowp bowv bpck bpip bprt_a " +
    "bprt_b bry0 bry1 bryg bryp bryv bryv_m bs bslimb bsrld bstblank btr1 btr1-a btr1-b btr2 btr2-a btr2-b " +
    "bump bust2 bust2_2x bust2a bust2a_2x bust3 bust3_2x bust3a bust3a_2x bust4 bust4_2x bust4a bust4a_2x " +
    "bust5 bust5_2x bvine c2 c2limb c2x10 c2x10_mdm07 c2x10_mdm07b c2x10e c2x18_mdm07 c2x20_mdm07 c2x6 c2x6e " +
    "c2x8 c3 c3limb c3x10 c3x10e c3x20 c3x21_mdm07 c3x24_mdm07 c3x37 c3x6 c3x8 c3x8e c4x12e c4x24 c4x25 c4x4 " +
    "c5x21_mdm07 c6x18_a c6x18_b cab_1 cab_2 cany cargo cargo2 cargowlk carpet cbn0 cbng cbnp cbnpk1 cbnpk5 " +
    "cbnv cbnv_m cdrd chair chair07 chair2 chair2m chair3 chair3m chr4 clight clight0 clmp clmz clmz10 clths " +
    "coff-1 coff-2 coff-2l con0 con1 con2 con4 con5 cong conp conv conv_m coolrod core corv1 corv1_flt " +
    "corv_lo1 corv_lo1_flt corv_lo1mini cran cran45_1 crazycrt crbn crbn_0 crbn_1 crbn_2 crbn_3 crbn_4 " +
    "crbnstem crow crow01 crt-push crt1 crt2 crt4-1 crt4-2 crt4-3 crt4-4 crt4-5 crt4-6 crt6-1 crt6-2 crt9 " +
    "crt_8 crttoss1 crttoss2 crtz crtzlid crtzlid2 ctf_e3x3 ctrn d10x10 d10x375 d11x5625 d2x3 d2x3_1 d2x3_2a " +
    "d2x3_2b d2x3_3c d2x3_3d d2x3_4 d2x3_s2l1 d3x2_2 d3x3_1 d3x3_2a d3x3_2b d3x3_3a d3x3_3b d3x3_3c d3x3_3d " +
    "d3x3_4c d3x3_4d d3x3odda d3x3oddb d4x3_1 d4x3_2 d4x3_2a d4x3_2b d4x3_3c d4x3_3d d4x3_s2l1 d4x4 d4x4_2a " +
    "d4x4_2b d5x4 d6x6 d8x4t d8x5_a d8x5_b d8x5fake d8x8 d9x3 dark darktroophead det0 det1 detg detp detp_1 " +
    "detv detv_m deye deyedoor dflt dhed di disc dkey dome dome2 dr13half dr4 dr4hole dr6half dread dread_flt " +
    "drill dtube0 dtube1 du du-d1 du-d2 du-d3 du-d4 du-d5 du-d6 du2 du2alt dualt dui dui2 dvboss dwtr e2x2 " +
    "e2x2_0 e2x4 e3x3 e3x3reac e4x4 e4x4_1 e4x4_2 e4x4_2i e4x4_3 e4x8 e6x6_1 e8x16 e8x4 e8x8 e8x8stru ec ecel " +
    "epack eweb eweb0 ewebbase falcon1 falcon1_flt falcon_lo1 falcon_lo1_flt fan0 fan0big fan1 farsight fdor_a " +
    "fdor_b fdrj ff6x6 fistg fistv fistv_m fklift flgr flgy fls0 flsg flsp flsp_1 flsv flsv_m fplc frcbg " +
    "freight1 freight1_flt freight_lo1 g-key g_lite game gan1 gan2 gan3 gantry gdoor-2 ggun gm go gogl gr grgd " +
    "gwndw gwndw_2 gwndw_x3 gwndwdam hepk hol3 holocube hpad ic iced icrpt id interd1 interd1_flt interd_lo1 " +
    "interd_lo1_flt io it j2x3 j2x3_1 ja je jmnd jmndslab jphnx jphnxfly jphnxprk ka kb kd kdlimb kelbite " +
    "keyblu keyyel kk kkboss kkbryar kkduel ks ky ky-0 kya10 kya11 kya12 kya15 kya16 kya17 kya18 kya19 kya9 " +
    "kyab kyap kyasleep kyb3 kyc5 kyd0 kydarth kydm kye6 kyf2 kyg7 kyh4 kyh4b kyh4g kyh4r kyh4y kyi14 kyj1 " +
    "kyk7 kykb kyl8 kyluke kym13 kym13b kym13g kym13r kym13y kymj kyp2 kypr kyprb kyprg kyprr kypry kyrc kyrm " +
    "kyro kyst kyt0 kytp kyu0 kyv0 kyw0 kywq kyx0 kyy0 l4x4 l4x4_2 l_lite l_lite2 lamp lamp2 landpad lb lb2 " +
    "ld4x4 levr-1 lfix lift ligt ligt2 lite ltshut m10colmn m12ball m2 m2heat ma mana1 mb mdm02clmp mdm10p " +
    "mdm10p2 mdm10wlk med mesa mj mj-0 mjblastk mjboss mjduel mjnotex mjsaber mjseat mn mndr mpip5 mpip6 mpip9 " +
    "mtbl mx my mylimb neb1 neb1_flt neb_lo1 neb_lo1_flt neb_lo1mini ng nullpov oc oclimb oldja oldk4 p1 " +
    "p1limb p2 p2xhf_1 p2xhf_2 p2xhf_3 p2xhf_4 p2xhf_5 p3 p4 packrev payload payloada payloadb payloadc " +
    "payloadd pb pb_1 pb_2 pb_3 pb_4 pb_5 pbkey pcel pclmp pcoup pd pd45 pdpart pi pipebolt pist plat plathalf " +
    "pontoon prdg prdp prdv prgv ptre pump pump_a pump_b pump_c r-key r2 r2x1 r41_1 r41_1_flt r5 r5part ra " +
    "raalt radiold raillite rc rc-dead1 rc-dead2 rc-float rck1 rck2 rck2mini rck3 rcktoss2 rcktoss3 rcktoss4 " +
    "rcrg redsphr remo rep0 repp repv rh rhlimb rhstr rld0 rldg rldp rldv rldv_m rm ro ro-dead1 ro-dead2 " +
    "roadblk roadsign rod02 rok_1 rok_2 rope01 rope02 rope03 rpt0 rptg rptp rptv rptv_m rs ry rylimb rystr s0 " +
    "s0-d1 s0-d2 s0-d3 s0-d4 s0-d5 s0-d6 s0alt s0blade s1 s1-d1 s1-d2 s1-d3 s1-d4 s1-d5 s1-d6 s1alt s1blade s2 " +
    "s2eaten s2l1step s2l4gate s3 s4 s4l2fan s5 sa sab0 sab0blue sab0dred sab0gree sab0oran sab0purp sab0red " +
    "sab0yell sabg sabgpoly sabp sabv sabv_m sabvblde sabvlite sal sc scam scambase sch1 scpe scrg sdes " +
    "secdoor secdoor2 seq0 seqb seqb_m seqg seqp seqp_1 seqv seqv_m sfun sgun shard0 shard1 shld shrd_1 shrd_2 " +
    "shrd_3 shrd_4 shrp_1 shrp_2 shrp_3 shrp_4 shrp_5 shut shutdunc shutfly shutr sign skr0 skrg skrp skrv " +
    "skrv_m skyhop skyhopmodel slab1 slab2 slab3 sofa sphere sphere2 sscg sscv sscv_m st stat statpole steaten " +
    "stgib1 stgib2 stgib3 sthcwlk stlamp stlamp1 stlimb stlt stpack stped str0 strg strp strut03 strut06 strv " +
    "strv_m su supt sw swhead t-key table07 table07a table07b tarp tarp2 tbl2 tbl4 tent th thlimb thout " +
    "thrncolm throne thstr tieb tieb_1 tieb_2 tieb_3 tieb_4 tief tief01 tief_1 tief_2 tief_3 tiei tiei_1 " +
    "tiei_2 tiei_3 tiei_4 tk tklimb tkstr towr tp transb1 transb1_flt transb_lo1 transb_lo1_flt tree trel trid " +
    "trnsprt1 trnsprt1_flt trpnl ts tsbk_1 tsbk_2 tsbk_3 tsbk_4 tsbk_5 tsbk_6 tsbk_7 tsbk_8 tspd tspdup tspov " +
    "ttrn tug1 tug1_flt tug_prt tur1 tur2 tur3 tur4 twig_prt twing1 twing1_flt twr_1 u2 u2alt ug ugalt utdr " +
    "v_deb1 v_deb2 v_deb3 v_deb4 v_deb5 vap1 vapr vegstand vest vestl vf vfspittl vr vsd1 vsd1_flt vsd_lo1 " +
    "vsd_lo1_flt vsd_lo2 vsd_lo2_flt vv vvalt w2 walt walt_a walt_b walt_c wcrt wcrt2 wcrt3 wcrt6-0 wcrt6-1 " +
    "wct3x4 wg wght01 wght02 wledge wm wm-0 wm-1 wm-2 wn3a wn3b wpmp wpmpblca wpmpblcb wpmpbloc wq ws wslimb " +
    "wtrw wwhl xtank1a xtank1b xtank3a xtank3b xtank4a xtank4b xwing1 xwing1_flt xwng_prt xwnglnd y-key ys " +
    "ysbranch yss yu yundead ywig_prt ywing1 ywing1_flt z95_1 z95_1_flt z95_1d0 z95_1d1 z95_1d2 z95_1d3 zpip"
).split(" "));
