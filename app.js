(() => {
  "use strict";
  const cfg = window.AUTOSETU_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const state = { client: null, user: null, profile: null, resendTimer: null, realtime: [], location: null };
  const views = ["landing-view","auth-view","profile-view","dashboard-view"];
  const showView = (id) => { views.forEach(v => $(v).classList.toggle("hidden", v !== id)); window.scrollTo({top:0,behavior:"smooth"}); };
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function toast(message, type="info") { const el=$("toast"); el.textContent=message; el.className=`toast ${type}`; setTimeout(()=>el.classList.add("hidden"),4200); }
  function authMessage(message, type="info") { const el=$("auth-message"); el.textContent=message; el.className=`notice ${type}`; }
  function friendlyError(error) {
    const m = String(error?.message || error || "");
    console.error("[AutoSetu]", error);
    if (/rate limit/i.test(m)) return "Too many attempts. Please wait a little before trying again.";
    if (/invalid.*otp|otp.*invalid/i.test(m)) return "That code isn't correct. Check it and try again.";
    if (/expired/i.test(m)) return "That code has expired. Request a new OTP.";
    if (/row-level security|permission denied/i.test(m)) return "This action isn't allowed for this account. Check the database setup and account role.";
    if (/schema cache|profiles/i.test(m)) return "The profile database is not ready yet. Run the database SQL files in the README order.";
    if (/fetch|network/i.test(m)) return "Connection problem. Check your internet and Supabase configuration.";
    return "Something went wrong. Please try again. If it continues, check the browser console and Supabase logs.";
  }
  function requireClient() {
    if (!window.supabase || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR_") || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY.includes("YOUR_")) {
      toast("Add your Supabase URL and public anon/publishable key in config.js first.", "error"); return false;
    }
    if (!state.client) state.client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    return true;
  }
  let authMode = "login";
  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === "signup";
    $("auth-tab-login").className = `btn ${signup ? "btn-outline" : "btn-primary"}`;
    $("auth-tab-signup").className = `btn ${signup ? "btn-primary" : "btn-outline"}`;
    $("auth-title").textContent = signup ? "Create your AutoSetu account" : "Log in to AutoSetu";
    $("auth-subtitle").textContent = signup ? "Verify your email to activate your account." : "Use your email and password.";
    $("signup-fields").classList.toggle("hidden", !signup);
    $("signup-role-wrap").classList.toggle("hidden", !signup);
    $("auth-name").required = signup;
    $("auth-password").autocomplete = signup ? "new-password" : "current-password";
    $("auth-submit").textContent = signup ? "Create account" : "Log in";
    $("auth-message").classList.add("hidden");
  }
  async function submitEmailAuth(e) {
    e.preventDefault(); if (!requireClient()) return;
    const email = $("auth-email").value.trim().toLowerCase();
    const password = $("auth-password").value;
    const btn = $("auth-submit"); btn.disabled = true; btn.textContent = authMode === "signup" ? "Creating…" : "Signing in…";
    try {
      if (authMode === "signup") {
        const fullName = $("auth-name").value.trim();
        const role = $("auth-role").value;
        if (fullName.length < 2) throw new Error("Please enter your full name.");
        if (password.length < 8) throw new Error("Use a password with at least 8 characters.");
        const redirectTo = window.location.href.split("#")[0];
        const { data, error } = await state.client.auth.signUp({
          email, password,
          options: { emailRedirectTo: redirectTo, data: { full_name: fullName, requested_role: role } }
        });
        if (error) throw error;
        if (data.session) {
          await onSession(data.session);
          toast("Account created successfully.", "success");
        } else {
          authMessage("Account created. Open the verification email sent to " + email + ", then return here and log in. Check Spam/Junk if you don't see it.", "success");
        }
      } else {
        const { data, error } = await state.client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (!data.session) throw new Error("Login did not create a session. Please try again.");
        await onSession(data.session);
        toast("Welcome back to AutoSetu.", "success");
      }
    } catch (err) {
      let message = err.message || friendlyError(err);
      if (/email not confirmed/i.test(message)) message = "Please verify your email first. Open the latest AutoSetu verification email, then try logging in.";
      else if (/already registered|already been registered/i.test(message)) message = "This email already has an account. Choose Log in instead.";
      authMessage(message, "error");
    } finally { btn.disabled = false; btn.textContent = authMode === "signup" ? "Create account" : "Log in"; }
  }
  async function onSession(session) {
    // Called after login, signup, email confirmation, and Supabase auth-state changes.
    clearRealtime();
    if (!session?.user) {
      state.user = null;
      state.profile = null;
      $("nav-login").classList.remove("hidden");
      $("nav-logout").classList.add("hidden");
      showView("landing-view");
      return;
    }

    state.user = session.user;
    $("nav-login").classList.add("hidden");
    $("nav-logout").classList.remove("hidden");

    try {
      const { data, error } = await state.client
        .from("profiles")
        .select("id,full_name,email,phone,role,is_suspended")
        .eq("id", session.user.id)
        .maybeSingle();
      if (error) throw error;

      if (!data) {
        // The profile trigger may not have run (or the email was confirmed after a schema
        // change). Do not silently assign admin privileges; ask the user to complete profile.
        state.profile = null;
        $("profile-name").value = session.user.user_metadata?.full_name || "";
        const requestedRole = session.user.user_metadata?.requested_role;
        $("profile-role").value = requestedRole === "driver" ? "driver" : "passenger";
        showView("profile-view");
        return;
      }

      if (data.is_suspended) {
        await state.client.auth.signOut();
        state.user = null;
        state.profile = null;
        toast("This account is suspended. Please contact AutoSetu support.", "error");
        showView("landing-view");
        return;
      }

      state.profile = data;
      await renderDashboard();
    } catch (error) {
      console.error("[AutoSetu] Session/profile load failed:", error);
      state.profile = null;
      showView("profile-view");
      toast(friendlyError(error), "error");
    }
  }

  function clearRealtime() { state.realtime.forEach(ch => state.client?.removeChannel(ch)); state.realtime=[]; }
  async function saveProfile(e) {
    e.preventDefault(); if(!state.user)return;
    const name=$("profile-name").value.trim(), role=state.profile?.role || $("profile-role").value, email=state.user.email || null;
    if(name.length<2){toast("Please enter your name.","error");return;}
    const btn=e.submitter; if(btn){btn.disabled=true;btn.textContent="Saving…";}
    try {
      const {error}=await state.client.from("profiles").upsert({id:state.user.id,full_name:name,phone:state.user.phone||null,email,role},{onConflict:"id"});
      if(error)throw error;
      if(role==="driver") {
        const {error:driverError}=await state.client.from("drivers").upsert({user_id:state.user.id,vehicle_type:"auto",verification_status:"pending",is_online:false},{onConflict:"user_id"});
        if(driverError)throw driverError;
      }
      await loadProfile(); await renderDashboard(); toast("Profile saved.","success");
    } catch(err){toast(friendlyError(err),"error");}
    finally {if(btn){btn.disabled=false;btn.textContent="Save and continue";}}
  }
  function navToAuth(role) {
    showView("auth-view");
    setAuthMode("login");
    if (role === "driver") { authMessage("Driver? Log in or create an account, then select Driver during registration. New drivers need admin approval.", "info"); }
  }
  async function logout() { if(!state.client)return; clearRealtime(); const {error}=await state.client.auth.signOut(); if(error)toast(friendlyError(error),"error"); else {state.user=null;state.profile=null;showView("landing-view");toast("You are signed out.","success");} }
  function getLocation() {
    return new Promise((resolve,reject)=>{
      if(!navigator.geolocation)return reject(new Error("This browser does not support location."));
      navigator.geolocation.getCurrentPosition(pos=>resolve({lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy}),err=>reject(new Error(err.code===1?"Location permission was denied. Enter pickup manually.":"Could not get your location. Enter pickup manually.")),{enableHighAccuracy:true,timeout:12000,maximumAge:30000});
    });
  }
  async function useCurrentLocation() {
    const btn=$("use-location"); if(btn){btn.disabled=true;btn.textContent="Finding location…";}
    try {
      const loc=await getLocation();state.location=loc;
      $("pickup-lat").value=loc.lat;$("pickup-lng").value=loc.lng;
      $("pickup").value=`GPS location (±${Math.round(loc.accuracy)} m)`;
      toast("Pickup location detected.","success");
    } catch(e){toast(e.message,"error");}
    finally {if(btn){btn.disabled=false;btn.textContent="Use my current location";}}
  }
  function mapsUrl(lat,lng,dest) {
    const base="https://www.google.com/maps/dir/?api=1";
    return `${base}&origin=${encodeURIComponent(`${lat},${lng}`)}&destination=${encodeURIComponent(dest||`${lat},${lng}`)}`;
  }
  async function bookRide(e) {
    e.preventDefault();
    const pickup=$("pickup").value.trim(), destination=$("destination").value.trim(), vehicle=$("vehicle-type").value;
    const lat=Number($("pickup-lat").value),lng=Number($("pickup-lng").value);
    if(!pickup||!destination){toast("Enter both pickup and destination.","error");return;}
    if(!Number.isFinite(lat)||!Number.isFinite(lng)){toast("Use GPS or enter a pickup with coordinates. Distance-based driver matching needs GPS coordinates.","error");return;}
    const btn=e.submitter;if(btn){btn.disabled=true;btn.textContent="Requesting…";}
    try {
      const {data,error}=await state.client.rpc("request_ride",{p_pickup_location:pickup,p_destination:destination,p_pickup_latitude:lat,p_pickup_longitude:lng,p_destination_latitude:null,p_destination_longitude:null,p_vehicle_type:vehicle});
      if(error)throw error;
      toast("Ride request created. Waiting for an eligible driver.","success");
      await renderDashboard();
    }catch(err){toast(friendlyError(err),"error");}
    finally{if(btn){btn.disabled=false;btn.textContent="Request ride";}}
  }
  async function toggleOnline(isOnline) {
    try {
      let loc=null;if(isOnline)loc=await getLocation();
      const {error}=await state.client.rpc("set_driver_availability",{p_online:isOnline,p_latitude:loc?.lat??null,p_longitude:loc?.lng??null});
      if(error)throw error;
      toast(isOnline?"You are online. New requests may appear.":"You are offline.","success");await renderDashboard();
    }catch(e){toast(e.message?.includes("Location")?e.message:friendlyError(e),"error");}
  }
  async function acceptRide(rideId) {
    try{const {error}=await state.client.rpc("accept_ride",{p_ride_id:rideId});if(error)throw error;toast("Ride accepted.","success");await renderDashboard();}
    catch(e){toast(friendlyError(e),"error");}
  }
  async function updateRideStatus(rideId,status) {
    try{const {error}=await state.client.rpc("driver_update_ride_status",{p_ride_id:rideId,p_status:status});if(error)throw error;toast("Ride status updated.","success");await renderDashboard();}
    catch(e){toast(friendlyError(e),"error");}
  }
  async function getMyRides() {
    const {data,error}=await state.client.from("rides").select("id,passenger_id,driver_id,pickup_location,destination,pickup_latitude,pickup_longitude,vehicle_type,status,requested_at,accepted_at,arrived_at,started_at,completed_at,passenger:profiles!rides_passenger_id_fkey(full_name,phone),driver:profiles!rides_driver_id_fkey(full_name,phone)").or(`passenger_id.eq.${state.user.id},driver_id.eq.${state.user.id}`).order("requested_at",{ascending:false}).limit(20);
    if(error)throw error;return data||[];
  }
  async function renderDashboard() {
    if(!state.profile){showView("profile-view");return;}
    const role=state.profile.role;
    $("welcome-title").textContent=`Hello, ${state.profile.full_name.split(" ")[0]}`;
    $("welcome-subtitle").textContent=role==="driver"?"Keep it simple. Your next ride is here.":role==="admin"?"Platform overview and safety operations.":"Where would you like to go today?";
    $("role-kicker").textContent=role==="driver"?"DRIVER MODE":role==="admin"?"ADMINISTRATION":"PASSENGER DASHBOARD";
    $("role-pill").textContent=role.charAt(0).toUpperCase()+role.slice(1);
    showView("dashboard-view");
    const root=$("dashboard-content");root.innerHTML=`<div class="loading-card">Loading your dashboard…</div>`;
    try{
      if(role==="passenger") await renderPassenger(root);
      else if(role==="driver") await renderDriver(root);
      else if(role==="admin") await renderAdmin(root);
      else root.innerHTML='<div class="card"><h3>Account role not recognized</h3><p>Contact support.</p></div>';
      const channel=state.client.channel(`user-${state.user.id}-${Date.now()}`).on("postgres_changes",{event:"*",schema:"public",table:"rides"},payload=>{if(payload.new?.passenger_id===state.user.id||payload.new?.driver_id===state.user.id)renderDashboard();}).subscribe();
      state.realtime.push(channel);
    }catch(e){root.innerHTML=`<div class="notice error">${escapeHtml(friendlyError(e))}</div>`;}
  }
  function rideCard(r, mineRole) {
    const status=String(r.status||"requested").replaceAll("_"," ");
    const person=mineRole==="passenger"?(r.driver?.full_name||"Waiting for driver"):(r.passenger?.full_name||"Passenger");
    const actions=[];
    if(mineRole==="driver"&&r.status==="requested")actions.push(`<button class="btn btn-primary" data-action="accept" data-id="${r.id}">✓ ACCEPT RIDE / सवारी स्वीकार करें</button>`);
    if(mineRole==="driver"&&r.status==="accepted")actions.push(`<button class="btn btn-primary" data-action="arrived" data-id="${r.id}">I HAVE ARRIVED / मैं पहुँच गया</button>`);
    if(mineRole==="driver"&&r.status==="arrived")actions.push(`<p class="muted small">Ride-start OTP flow must be completed through the secure OTP RPC after the passenger receives their code.</p>`);
    if(mineRole==="driver"&&r.status==="started")actions.push(`<button class="btn btn-primary" data-action="complete" data-id="${r.id}">COMPLETE RIDE / सफर पूरा करें</button>`);
    const nav=(r.pickup_latitude&&r.pickup_longitude)?`<a class="btn btn-outline" target="_blank" rel="noopener" href="${mapsUrl(r.pickup_latitude,r.pickup_longitude,r.pickup_location)}">Navigate to pickup ↗</a>`:"";
    return `<article class="ride-card"><div class="ride-top"><span class="status status-${escapeHtml(r.status)}">${escapeHtml(status)}</span><small>${new Date(r.requested_at).toLocaleString()}</small></div><h3>${escapeHtml(r.pickup_location)} <span class="arrow">→</span> ${escapeHtml(r.destination)}</h3><div class="ride-meta"><span>🚕 ${escapeHtml(r.vehicle_type)}</span><span>👤 ${escapeHtml(person)}</span></div><div class="ride-actions">${actions.join("")}${nav}</div></article>`;
  }
  async function renderPassenger(root) {
    const rides=await getMyRides();
    root.innerHTML=`
      <div class="dashboard-grid">
        <section class="card booking-card"><div class="card-heading"><span class="big-icon">⌖</span><div><h2>Book a local ride</h2><p>Choose where your journey starts and ends.</p></div></div>
          <form id="booking-form" class="stack-form">
            <label>Pickup location<input id="pickup" required placeholder="Enter pickup or use GPS"></label>
            <button type="button" class="btn btn-outline" id="use-location">⌖ Use my current location</button>
            <input type="hidden" id="pickup-lat"><input type="hidden" id="pickup-lng">
            <label>Destination<input id="destination" required placeholder="Where are you going?"></label>
            <label>Vehicle type<select id="vehicle-type"><option value="auto">Auto-rickshaw</option><option value="taxi">Taxi</option></select></label>
            <button class="btn btn-primary btn-large full" type="submit">Request ride →</button>
          </form>
          <p class="muted small">GPS is used only after you grant browser permission. No nearby drivers are invented or displayed.</p>
        </section>
        <section class="card"><div class="card-heading"><span class="big-icon">🛡</span><div><h2>Safety centre</h2><p>Keep help within reach.</p></div></div><div class="emergency-box"><small>India emergency number</small><strong>112</strong><a href="tel:112" class="btn btn-dark">Call 112</a></div><p class="muted small">This opens your phone's dialler where supported; AutoSetu does not dispatch emergency services.</p><button class="btn btn-outline full" id="report-help">Report a ride concern</button></section>
      </div>
      <section class="section-block"><div class="section-title-row"><h2>Your recent rides</h2><span class="muted small">${rides.length} shown</span></div>${rides.length?rides.map(r=>rideCard(r,"passenger")).join(""):'<div class="empty-state"><span>🚕</span><h3>Your journeys will appear here</h3><p>Book a ride to get started.</p></div>'}</section>`;
    $("booking-form").addEventListener("submit",bookRide);$("use-location").addEventListener("click",useCurrentLocation);
    $("report-help").addEventListener("click",()=>showReportForm(root));
    root.querySelectorAll("[data-action]").forEach(b=>b.addEventListener("click",()=>{}));
  }
  async function renderDriver(root) {
    const {data:driver,error}=await state.client.from("drivers").select("verification_status,is_online,vehicle_type,vehicle_number,rating,total_rides").eq("user_id",state.user.id).maybeSingle();
    if(error)throw error;
    if(!driver){root.innerHTML='<div class="card"><h2>Finish driver setup</h2><p>Your driver record is not set up yet. Update your profile role to Driver.</p><button class="btn btn-outline" id="edit-profile">Edit profile</button></div>';return;}
    const {data:rides,error:rideError}=await state.client.from("rides").select("id,passenger_id,driver_id,pickup_location,destination,pickup_latitude,pickup_longitude,vehicle_type,status,requested_at,passenger:profiles!rides_passenger_id_fkey(full_name,phone)").or(`driver_id.eq.${state.user.id},and(driver_id.is.null,status.eq.requested,vehicle_type.eq.${driver.vehicle_type})`).order("requested_at",{ascending:false}).limit(20);
    if(rideError)throw rideError;
    root.innerHTML=`
      <div class="driver-status-card ${driver.is_online?"is-online":""}"><div><span class="eyebrow">YOUR STATUS</span><h2>${driver.is_online?"🟢 You're online":"⚪ You're offline"}</h2><p>${driver.is_online?"You can receive eligible ride requests.":"Go online when you're ready to drive."}</p></div><button class="btn ${driver.is_online?"btn-light":"btn-primary"} btn-large" id="availability">${driver.is_online?"GO OFFLINE / ऑफलाइन हों":"GO ONLINE / ऑनलाइन हों"}</button></div>
      ${driver.verification_status!=="approved"?`<div class="notice warning"><b>Approval required.</b> Your status is <b>${escapeHtml(driver.verification_status)}</b>. You cannot accept rides until an administrator approves your documents.</div>`:""}
      <div class="driver-stats"><div><small>Vehicle</small><b>${escapeHtml(driver.vehicle_type||"Not set")}</b></div><div><small>Rating</small><b>${Number(driver.rating||0).toFixed(1)} ★</b></div><div><small>Completed rides</small><b>${driver.total_rides||0}</b></div></div>
      <section class="section-block"><div class="section-title-row"><h2>New ride requests / नई सवारी</h2><span class="muted small">Tap accept only when ready</span></div>
      ${rides.length?rides.map(r=>rideCard(r,"driver")).join(""):'<div class="empty-state"><span>🛺</span><h3>No ride requests yet</h3><p>Stay online to see eligible requests.</p></div>'}</section>
      <section class="card"><h2>Driver help / मदद</h2><p>Drive safely. Confirm pickup details before starting. Never share a passenger's private details publicly.</p><a class="btn btn-outline" href="tel:112">Emergency: call 112</a></section>`;
    $("availability").addEventListener("click",()=>toggleOnline(!driver.is_online));
    root.querySelectorAll('[data-action="accept"]').forEach(b=>b.addEventListener("click",()=>acceptRide(b.dataset.id)));
    root.querySelectorAll('[data-action="arrived"]').forEach(b=>b.addEventListener("click",()=>updateRideStatus(b.dataset.id,"arrived")));
    root.querySelectorAll('[data-action="complete"]').forEach(b=>b.addEventListener("click",()=>toast("Completion must be confirmed with the secure passenger-authorized OTP flow; direct completion is blocked.","error")));
  }
  async function renderAdmin(root) {
    const {data:stats,error}=await state.client.rpc("admin_dashboard_stats");if(error)throw error;
    const {data:pending,error:pe}=await state.client.from("drivers").select("user_id,vehicle_type,vehicle_number,verification_status,profiles:user_id(full_name,phone)").eq("verification_status","pending").limit(50);
    if(pe)throw pe;
    root.innerHTML=`<div class="stats-grid"><div class="stat-card"><small>Passengers</small><strong>${stats.passengers}</strong></div><div class="stat-card"><small>Drivers</small><strong>${stats.drivers}</strong></div><div class="stat-card"><small>Total rides</small><strong>${stats.rides}</strong></div><div class="stat-card"><small>Completed</small><strong>${stats.completed}</strong></div><div class="stat-card"><small>Cancelled</small><strong>${stats.cancelled}</strong></div><div class="stat-card accent-stat"><small>Pending approvals</small><strong>${stats.pending_drivers}</strong></div></div>
      <section class="section-block"><div class="section-title-row"><h2>Driver approvals</h2><span class="muted small">Review documents outside this list before approving</span></div>
      ${pending.length?pending.map(d=>`<article class="ride-card"><h3>${escapeHtml(d.profiles?.full_name||"Driver")}</h3><p>${escapeHtml(d.profiles?.phone||"")} · ${escapeHtml(d.vehicle_type||"Vehicle not set")} · ${escapeHtml(d.vehicle_number||"Registration not supplied")}</p><span class="status status-requested">pending</span><div class="ride-actions"><button class="btn btn-primary" data-approve="${d.user_id}">Approve driver</button><button class="btn btn-outline" data-reject="${d.user_id}">Reject</button></div></article>`).join(""):'<div class="empty-state"><h3>No pending drivers</h3><p>New driver applications will appear here.</p></div>'}
      </section><p class="muted small">Administrator access is granted only by the secure database setup procedure, never through public signup.</p>`;
    root.querySelectorAll("[data-approve]").forEach(b=>b.addEventListener("click",()=>adminVerify(b.dataset.approve,"approved")));
    root.querySelectorAll("[data-reject]").forEach(b=>b.addEventListener("click",()=>adminVerify(b.dataset.reject,"rejected")));
  }
  async function adminVerify(userId,status){try{const {error}=await state.client.rpc("admin_set_driver_verification",{p_user_id:userId,p_status:status});if(error)throw error;toast(`Driver ${status}.`,"success");await renderDashboard();}catch(e){toast(friendlyError(e),"error");}}
  function showReportForm(root) {
    const box=document.createElement("div");box.className="card report-form";box.innerHTML=`<h2>Report a safety concern</h2><form id="report-form" class="stack-form"><label>Ride ID (from ride details)<input id="report-ride-id" placeholder="Ride UUID" required></label><label>Category<select id="report-category"><option value="safety">Safety</option><option value="conduct">Conduct</option><option value="payment">Payment</option><option value="other">Other</option></select></label><label>What happened?<textarea id="report-description" required maxlength="2000" rows="3"></textarea></label><button class="btn btn-primary">Submit report</button></form>`;
    root.prepend(box);$("report-form").addEventListener("submit",async e=>{e.preventDefault();try{const {error}=await state.client.from("ride_reports").insert({ride_id:$("report-ride-id").value.trim(),reported_by:state.user.id,category:$("report-category").value,description:$("report-description").value.trim()});if(error)throw error;toast("Report submitted. Thank you for letting us know.","success");box.remove();}catch(err){toast(friendlyError(err),"error");}});
  }
  async function init() {
    $("year").textContent=new Date().getFullYear();
    $("nav-login").addEventListener("click",()=>navToAuth("passenger"));
    $("nav-logout").addEventListener("click",logout);
    $("hero-book").addEventListener("click",()=>navToAuth("passenger"));
    $("hero-drive").addEventListener("click",()=>navToAuth("driver"));
    $("auth-back").addEventListener("click",()=>showView("landing-view"));
    setAuthMode("login");
    $("email-auth-form").addEventListener("submit",submitEmailAuth);
    $("auth-tab-login").addEventListener("click",()=>setAuthMode("login"));
    $("auth-tab-signup").addEventListener("click",()=>setAuthMode("signup"));
    $("profile-form").addEventListener("submit",saveProfile);
    if("serviceWorker" in navigator && location.protocol.startsWith("https")) navigator.serviceWorker.register("./sw.js").catch(()=>{});
    if(!requireClient())return;
    const {data:{session}}=await state.client.auth.getSession();await onSession(session);
    state.client.auth.onAuthStateChange((_event,session)=>{setTimeout(()=>onSession(session),0);});
  }
  document.addEventListener("DOMContentLoaded",init);
})();
