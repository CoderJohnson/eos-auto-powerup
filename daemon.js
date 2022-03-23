const { Api, JsonRpc, Serialize, RpcError, JsSignatureProvider } = require('eosjs'); // eosjs@20.0.0beta2
const schedule = require('node-schedule');

const fetch = require('node-fetch');
const { TextDecoder, TextEncoder } = require('text-encoding');

const defaultPrivateKey = ''; // Enter the private key here
const defaultPermission = 'active'; // Enter the permissions corresponding to the key
const signatureProvider = new JsSignatureProvider([defaultPrivateKey]);
const actor = ""; // Enter the account used to purchase the resource

const node = "http://eos.greymass.com"; // Enter the public node used to push transactions here

const rpc = new JsonRpc( node, {fetch} );

const api = new Api({
    rpc,
    signatureProvider,
    textDecoder: new TextDecoder(),
    textEncoder: new TextEncoder()
});

let fee=0;
let maxPayment=0.0060; // Set an upper limit on the amount of a single purchase.
let powerup_frac = 1000000000000000;

let net_frac = 3142875; // Fraction of net (100% = 10^15) managed by resource market
let cpu_frac = 130953090; // Fraction of cpu (100% = 10^15) managed by resource market

let net_amount = 0;
let cpu_amount = 0;

const floatStr = function(num, precision){
    let value = Math.round( parseFloat(num) * Math.pow(10, precision) ) / Math.pow(10, precision);
    let xsd = value.toString().split(".");
    if (xsd.length == 1){
        value = value.toString() + (precision === 0 ? "" : ".");
        for(let x = 0; x < precision; x++) {
            value = value.toString() + "0";
        }
        return value;
    }
    if (xsd.length > 1){
        if( xsd[1].length < precision ){
            for(let x = 0; x < ( precision - ( xsd[1].length ) ); x++) {
                value = value.toString() + "0";
            }
        }else{
            value = value.toString();
        }
        return value;
    }
};

function calcPowerupFee(state, utilization_increase){
    if( utilization_increase <= 0 ) return 0;

    function price_integral_delta( start_utilization, end_utilization ){
        let coefficient = ( state.max_price - state.min_price ) / state.exponent;
        let start_u     = double(start_utilization) / state.weight;
        let end_u       = double(end_utilization) / state.weight;
        return state.min_price * end_u - state.min_price * start_u + coefficient * Math.pow(end_u, state.exponent) - coefficient * Math.pow(start_u, state.exponent);
    }

    function price_function(utilization){
        let price = state.min_price;
        let new_exponent = state.exponent - 1.0;
        if (new_exponent <= 0.0) {
            return state.max_price;
        } else {
            price += (state.max_price - state.min_price) * Math.pow(utilization / state.weight, new_exponent);
        }
        return price;
    }

    let fee = 0;
    let start_utilization = state.utilization;
    let end_utilization   = start_utilization + utilization_increase;

    if (start_utilization < state.adjusted_utilization) {
        fee += price_function(state.adjusted_utilization) *
            Math.min(utilization_increase, state.adjusted_utilization - start_utilization) / state.weight;
        start_utilization = state.adjusted_utilization;
    }

    if (start_utilization < end_utilization) {
        fee += price_integral_delta(start_utilization, end_utilization);
    }

    return Number((Math.ceil(fee) / 10000).toFixed(4));
}

function process(frac, amount, state){
    if (!frac) return;
    if (!state.weight) return;
    if (state.utilization + amount > state.weight) return;
    amount = frac * state.weight / powerup_frac;
    let f = calcPowerupFee(state, amount);
    if (f <= 0) return;
    fee += f;
    fee = Number(fee.toFixed(4));
    state.utilization += amount;
}

function powerUp(){
    try{
        fee=0;
        fetch( node + '/v1/chain/get_table_rows', {
            method: 'post',
            body: JSON.stringify({
                code: "eosio",
                table: "powup.state",
                limit: 1,
                scope: "0",
                index_position: 1,
                json: true,
                key_type: "",
                lower_bound: "",
                upper_bound: "",
                reverse: false
            })
        }).then( response => {
            try{
                response.json().then(data => {
                    //console.log(data);
                    if(data.rows && data.rows[0] && data.rows[0].cpu){
                        let state = data.rows[0];
                        state.cpu.max_price = parseFloat(state.cpu.max_price)*10000;
                        state.net.max_price = parseFloat(state.net.max_price)*10000;
                        state.cpu.min_price = parseFloat(state.cpu.min_price)*10000;
                        state.net.min_price = parseFloat(state.net.min_price)*10000;
                        process(net_frac, net_amount, state.net);
                        process(cpu_frac, cpu_amount, state.cpu);
                        if (fee * 2 > maxPayment) return;
                        if (fee === 0 || fee < state.min_powerup_fee) return;
                        //console.log(fee);

                        try {
                            api.transact({
                                actions: [{
                                    account: 'eosio',
                                    name: 'powerup',
                                    authorization: [{
                                        actor: actor,
                                        permission: defaultPermission
                                    }],
                                    data: {
                                        cpu_frac: cpu_frac,
                                        net_frac: net_frac,
                                        days: 1,
                                        max_payment: floatStr(fee * 2, 4) + ' EOS',
                                        payer: actor,
                                        receiver: actor
                                    },
                                }]
                            }, {
                                blocksBehind: 3,
                                expireSeconds: 30,
                            });
                        } catch (e) {
                            //console.log(e);
                        }
                    }
                })
            }catch(e){
                //console.log(e);
            }
        });
    }catch(e){
        //console.log(e);
    }
}

// Set up scheduled tasks

schedule.scheduleJob({hour: [9, 15, 21], minute: 10, second: 10},function(){ powerUp(); });
